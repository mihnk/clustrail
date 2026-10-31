package kube

import (
	"context"
	"errors"
	"k8s.io/apimachinery/pkg/types"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	k8stesting "k8s.io/client-go/testing"
)

func TestDebugProfilesMatchKubectl(t *testing.T) {
	general, _ := debugSecurity("general")
	if general == nil || general.Capabilities.Add[0] != "SYS_PTRACE" {
		t.Fatalf("general = %+v", general)
	}
	if b, err := debugSecurity("baseline"); b != nil || err != nil {
		t.Fatalf("baseline = %+v %v", b, err)
	}
	r, _ := debugSecurity("restricted")
	if !*r.RunAsNonRoot || *r.AllowPrivilegeEscalation || r.Capabilities.Drop[0] != "ALL" {
		t.Fatalf("restricted = %+v", r)
	}
	if s, _ := debugSecurity("sysadmin"); !*s.Privileged {
		t.Fatal("sysadmin is privileged")
	}
	if _, err := debugSecurity("root"); err == nil {
		t.Fatal("unknown profiles are refused")
	}
}

func TestAddDebugContainer(t *testing.T) {
	p := pod("checkout-api-a", nil)
	c, client, _ := newFakeConn(t, p)
	// The fake API server has no kubelet: report the ephemeral container running once added.
	client.PrependReactor("get", "pods", func(a k8stesting.Action) (bool, runtime.Object, error) {
		obj, err := client.Tracker().Get(corev1.SchemeGroupVersion.WithResource("pods"), "payments", a.(k8stesting.GetAction).GetName())
		if err != nil {
			return true, nil, err
		}
		got := obj.(*corev1.Pod).DeepCopy()
		for _, ec := range got.Spec.EphemeralContainers {
			got.Status.EphemeralContainerStatuses = append(got.Status.EphemeralContainerStatuses, corev1.ContainerStatus{Name: ec.Name, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}})
		}
		return true, got, nil
	})
	m := managerWith(c, false)
	dc, err := m.AddDebugContainer(DebugRequest{Cluster: "test", Namespace: "payments", Pod: p.Name, Image: "busybox:1.37", Target: "api", Profile: "netadmin"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(dc.Container, "debugger-") || dc.Pod != p.Name {
		t.Fatalf("container = %+v", dc)
	}
	obj, _ := client.Tracker().Get(corev1.SchemeGroupVersion.WithResource("pods"), "payments", p.Name)
	ecs := obj.(*corev1.Pod).Spec.EphemeralContainers
	if len(ecs) != 1 || ecs[0].TargetContainerName != "api" || ecs[0].Image != "busybox:1.37" || !ecs[0].TTY || ecs[0].SecurityContext.Capabilities.Add[0] != "NET_ADMIN" {
		t.Fatalf("ephemeral containers = %+v", ecs)
	}

	if _, err := m.AddDebugContainer(DebugRequest{Cluster: "test", Namespace: "payments", Pod: p.Name, Image: "busybox", Target: "nope"}); err == nil {
		t.Fatal("an unknown target container is refused")
	}
	if _, err := managerWith(c, true).AddDebugContainer(DebugRequest{Cluster: "test", Namespace: "payments", Pod: p.Name, Image: "busybox"}); err != ErrReadOnly {
		t.Fatalf("read-only err = %v", err)
	}
}

func TestNodeShellPod(t *testing.T) {
	p := nodeShellPod(NodeShellRequest{Node: "ip-10-4-12-87.eu-west-1.compute.internal", Namespace: "kube-system", Image: "busybox:1.37"}, "inst1")
	if len(p.Name) > 63 || !strings.HasPrefix(p.Name, "clustrail-node-shell-ip-10-4-12-87-eu-west-1") || strings.Contains(p.Name, ".") {
		t.Fatalf("name = %q", p.Name)
	}
	s := p.Spec
	if s.NodeName != "ip-10-4-12-87.eu-west-1.compute.internal" || !s.HostPID || !s.HostNetwork || !s.HostIPC || s.Tolerations[0].Operator != corev1.TolerationOpExists {
		t.Fatalf("spec = %+v", s)
	}
	if !*s.Containers[0].SecurityContext.Privileged || s.Volumes[0].HostPath.Path != "/" || s.Containers[0].VolumeMounts[0].MountPath != "/host" {
		t.Fatalf("container = %+v", s.Containers[0])
	}
	if p.Labels[nodeShellLabel] != "true" {
		t.Fatalf("labels = %v", p.Labels)
	}
}

func TestNodeShellsAreOnlyDeletedWhenClustrailStartedThem(t *testing.T) {
	other := pod("someone-elses", nil)
	c, client, _ := newFakeConn(t, other)
	m := managerWith(c, false)
	if err := m.DeleteNodeShell("test", "payments", "someone-elses"); err == nil {
		t.Fatal("deleting a pod Clustrail did not start must be refused")
	}
	m.shells.pods = map[string]NodeShell{"test/payments/someone-elses": {Namespace: "payments", Pod: "someone-elses"}}
	m.CleanupNodeShells()
	if _, err := client.CoreV1().Pods("payments").Get(context.Background(), "someone-elses", metav1.GetOptions{}); err == nil {
		t.Fatal("cleanup should delete the node shells it tracks")
	}
	if _, err := managerWith(c, true).StartNodeShell(NodeShellRequest{Cluster: "test", Node: "n"}); err != ErrReadOnly {
		t.Fatalf("read-only err = %v", err)
	}
}

func shellPod(name, install string, mut func(*corev1.Pod)) *corev1.Pod {
	return pod(name, func(p *corev1.Pod) {
		p.Namespace = "kube-system"
		p.UID = types.UID(name + "-uid")
		p.Labels = map[string]string{nodeShellLabel: "true"}
		if install != "" {
			p.Labels[installLabel] = install
		}
		if mut != nil {
			mut(p)
		}
	})
}

// On connect, this installation's node shells that no open shell uses are
// deleted; other installations' shells and open ones are left alone.
func TestNodeShellSweepDeletesOnlyOwnOrphans(t *testing.T) {
	orphan := shellPod("clustrail-node-shell-n1-orphn", "inst1", nil)
	open := shellPod("clustrail-node-shell-n1-openn", "inst1", nil)
	theirs := shellPod("clustrail-node-shell-n1-thrss", "inst2", nil)
	unlabeled := shellPod("clustrail-node-shell-n1-oldvr", "", nil) // started by an older version
	c, client, _ := newFakeConn(t, orphan, open, theirs, unlabeled)
	m := managerWith(c, false)
	m.store = &Store{data: settingsFile{InstallID: "inst1"}}
	m.shells.track("test/kube-system/"+open.Name, NodeShell{Namespace: "kube-system", Pod: open.Name})
	m.sweepNodeShells("test", c)
	exists := func(name string) bool {
		_, err := client.CoreV1().Pods("kube-system").Get(context.Background(), name, metav1.GetOptions{})
		return err == nil
	}
	if exists(orphan.Name) {
		t.Fatal("this installation's orphan must be deleted")
	}
	if !exists(open.Name) || !exists(theirs.Name) || !exists(unlabeled.Name) {
		t.Fatal("open shells, other installations' shells and unlabeled pods stay")
	}
}

// A pod held by a finalizer is not gone: it stays tracked, so quitting and
// the next connect try again.
func TestNodeShellHeldByAFinalizerStaysTracked(t *testing.T) {
	defer func(w time.Duration) { nodeShellGoneWait = w }(nodeShellGoneWait)
	nodeShellGoneWait = 100 * time.Millisecond
	held := shellPod("clustrail-node-shell-n1-heldd", "inst1", func(p *corev1.Pod) { p.Finalizers = []string{"example.com/hold"} })
	c, client, _ := newFakeConn(t, held)
	m := managerWith(c, false)
	key := "test/kube-system/" + held.Name
	m.shells.track(key, NodeShell{Namespace: "kube-system", Pod: held.Name})
	m.shells.setUID(key, held.UID)
	podsGVR := corev1.SchemeGroupVersion.WithResource("pods")
	client.PrependReactor("delete", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		obj, _ := client.Tracker().Get(podsGVR, "kube-system", held.Name)
		p := obj.(*corev1.Pod).DeepCopy()
		now := metav1.Now()
		p.DeletionTimestamp = &now
		_ = client.Tracker().Update(podsGVR, p, "kube-system")
		return true, nil, nil
	})
	err := m.DeleteNodeShell("test", "kube-system", held.Name)
	if err == nil || !strings.Contains(err.Error(), "finalizers example.com/hold") {
		t.Fatalf("err = %v", err)
	}
	if _, ok := m.shells.pods[key]; !ok {
		t.Fatal("a pod that is still there stays tracked")
	}
}

// A shell is tracked before its pod is created, so a sweep running at the
// same time never takes it for an orphan; the pod carries the install label
// and ends by itself after nodeShellLifetime.
func TestNodeShellIsTrackedBeforeItIsCreated(t *testing.T) {
	c, client, _ := newFakeConn(t, &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "n1"}})
	m := managerWith(c, false)
	m.store = &Store{data: settingsFile{InstallID: "inst1"}}
	var trackedAtCreate bool
	var created *corev1.Pod
	client.PrependReactor("create", "pods", func(a k8stesting.Action) (bool, runtime.Object, error) {
		created = a.(k8stesting.CreateAction).GetObject().(*corev1.Pod)
		m.shells.mu.Lock()
		_, trackedAtCreate = m.shells.pods["test/kube-system/"+created.Name]
		m.shells.mu.Unlock()
		return true, nil, errors.New("admission webhook denied the request")
	})
	if _, err := m.StartNodeShell(NodeShellRequest{Cluster: "test", Node: "n1"}); err == nil {
		t.Fatal("the create error is returned")
	}
	if !trackedAtCreate {
		t.Fatal("the shell must be tracked before its pod is created")
	}
	if len(m.shells.pods) != 0 {
		t.Fatal("a pod that was never created is untracked")
	}
	if created.Labels[installLabel] != "inst1" || created.Spec.ActiveDeadlineSeconds == nil || *created.Spec.ActiveDeadlineSeconds != int64(nodeShellLifetime/time.Second) {
		t.Fatalf("pod = %+v", created.ObjectMeta.Labels)
	}
}
