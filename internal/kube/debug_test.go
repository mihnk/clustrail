package kube

import (
	"context"
	"strings"
	"testing"

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
	p := nodeShellPod(NodeShellRequest{Node: "ip-10-4-12-87.eu-west-1.compute.internal", Namespace: "kube-system", Image: "busybox:1.37"})
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
