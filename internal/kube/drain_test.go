package kube

import (
	"context"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

// drainFixture: two ReplicaSet pods on node-1. Evicting "slow" marks it
// terminating with a finalizer instead of deleting it; "web" is deleted.
func drainFixture(t *testing.T) (*Manager, *recorder, func(name string) *corev1.Pod, func(p *corev1.Pod)) {
	t.Helper()
	mk := func(name string) *corev1.Pod {
		return pod(name, func(p *corev1.Pod) {
			p.Spec.NodeName = "node-1"
			p.UID = types.UID(name + "-uid-1")
			p.OwnerReferences = []metav1.OwnerReference{{Kind: "ReplicaSet", Name: "rs", Controller: ptr(true)}}
		})
	}
	c, client, rec := newFakeConn(t, &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "node-1"}}, mk("web"), mk("slow"))
	c.ctx = context.Background()
	podsGVR := corev1.SchemeGroupVersion.WithResource("pods")
	client.PrependReactor("create", "pods", func(a k8stesting.Action) (bool, runtime.Object, error) {
		if a.GetSubresource() != "eviction" {
			return false, nil, nil
		}
		name := a.(k8stesting.CreateAction).GetObject().(*policyv1.Eviction).Name
		if name == "slow" {
			obj, _ := client.Tracker().Get(podsGVR, "payments", name)
			p := obj.(*corev1.Pod).DeepCopy()
			now := metav1.Now()
			p.DeletionTimestamp, p.Finalizers = &now, []string{"example.com/flush"}
			_ = client.Tracker().Update(podsGVR, p, "payments")
		} else {
			_ = client.Tracker().Delete(podsGVR, "payments", name)
		}
		return true, &policyv1.Eviction{}, nil
	})
	get := func(name string) *corev1.Pod {
		obj, err := client.Tracker().Get(podsGVR, "payments", name)
		if err != nil {
			return nil
		}
		return obj.(*corev1.Pod)
	}
	replace := func(p *corev1.Pod) {
		_ = client.Tracker().Delete(podsGVR, "payments", p.Name)
		if p.UID != "" {
			_ = client.Tracker().Add(p)
		}
	}
	return managerWith(c, false), rec, get, replace
}

func lastJob(rec *recorder) Job {
	js := rec.jobs()
	if len(js) == 0 {
		return Job{}
	}
	return js[len(js)-1]
}

func TestDrainWaitsForPodsToBeGone(t *testing.T) {
	defer func(d time.Duration) { drainPoll = d }(drainPoll)
	drainPoll = 20 * time.Millisecond
	m, rec, get, replace := drainFixture(t)
	if _, err := m.DrainNode("test", "node-1", DrainOptions{TimeoutSec: 30}, "jane"); err != nil {
		t.Fatal(err)
	}
	// Both evictions are accepted, but "slow" is still terminating: the drain is not done.
	waitFor(t, "slow terminating", func() bool { return strings.Contains(lastJob(rec).Detail, "1 terminating") })
	time.Sleep(100 * time.Millisecond)
	if j := lastJob(rec); j.Done || j.Progress >= 1 || !strings.Contains(j.Detail, "2 of 2 evicted · 1 gone") {
		t.Fatalf("job while a pod terminates = %+v", j)
	}
	// The finalizer is removed and a new pod with the same name starts elsewhere: that is not the evicted pod.
	again := get("slow").DeepCopy()
	again.UID, again.DeletionTimestamp, again.Finalizers, again.Spec.NodeName, again.ResourceVersion = "slow-uid-2", nil, nil, "node-2", ""
	replace(again)
	waitFor(t, "drain done", func() bool { return lastJob(rec).Done })
	if j := lastJob(rec); j.Error != "" || j.Progress != 1 || j.Detail != "2 pods evicted and gone · node stays cordoned" {
		t.Fatalf("last job = %+v", j)
	}
}

func TestDrainTimeoutNamesPodsStillTerminating(t *testing.T) {
	defer func(d, min time.Duration) { drainPoll, drainMinTimeout = d, min }(drainPoll, drainMinTimeout)
	drainPoll, drainMinTimeout = 20*time.Millisecond, 200*time.Millisecond
	m, rec, _, _ := drainFixture(t)
	if _, err := m.DrainNode("test", "node-1", DrainOptions{}, "jane"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "drain timeout", func() bool { return lastJob(rec).Done })
	j := lastJob(rec)
	if !strings.Contains(j.Error, "1 still terminating: payments/slow (finalizers: example.com/flush)") || !strings.Contains(j.Error, "cordoned but not empty") {
		t.Fatalf("timeout error = %q", j.Error)
	}
}

// A pod whose read fails is not gone: the drain must not report success
// because the deadline ended while the pod was being read.
func TestDrainTimeoutDuringAReadIsNotSuccess(t *testing.T) {
	defer func(d, min time.Duration) { drainPoll, drainMinTimeout = d, min }(drainPoll, drainMinTimeout)
	drainPoll, drainMinTimeout = 20*time.Millisecond, 300*time.Millisecond
	m, rec, _, _ := drainFixture(t)
	c, _ := m.conn("test")
	c.client.(*fake.Clientset).PrependReactor("get", "pods", func(a k8stesting.Action) (bool, runtime.Object, error) {
		if a.(k8stesting.GetAction).GetName() != "slow" {
			return false, nil, nil
		}
		time.Sleep(400 * time.Millisecond) // past the drain's deadline
		return true, nil, context.DeadlineExceeded
	})
	if _, err := m.DrainNode("test", "node-1", DrainOptions{}, "jane"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "drain done", func() bool { return lastJob(rec).Done })
	j := lastJob(rec)
	if j.Error == "" || !strings.Contains(j.Error, "timed out after") || !strings.Contains(j.Error, "payments/slow (state unknown)") {
		t.Fatalf("job = %+v", j)
	}
}

// A drain cut short by the connection closing says so, not "timed out".
func TestDrainStoppedByDisconnectSaysSo(t *testing.T) {
	defer func(d, min time.Duration) { drainPoll, drainMinTimeout = d, min }(drainPoll, drainMinTimeout)
	drainPoll, drainMinTimeout = 20*time.Millisecond, time.Minute
	m, rec, _, _ := drainFixture(t)
	c, _ := m.conn("test")
	ctx, cancel := context.WithCancel(context.Background())
	c.ctx = ctx
	if _, err := m.DrainNode("test", "node-1", DrainOptions{}, "jane"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "slow terminating", func() bool { return strings.Contains(lastJob(rec).Detail, "1 terminating") })
	cancel()
	waitFor(t, "drain done", func() bool { return lastJob(rec).Done })
	j := lastJob(rec)
	if !strings.Contains(j.Error, "stopped: the connection to the cluster closed") || !strings.Contains(j.Error, "payments/slow") || strings.Contains(j.Error, "timed out") {
		t.Fatalf("job = %+v", j)
	}
}

// A failing read is retried, never counted as gone.
func TestDrainReadErrorsKeepThePod(t *testing.T) {
	defer func(d, min time.Duration) { drainPoll, drainMinTimeout = d, min }(drainPoll, drainMinTimeout)
	drainPoll, drainMinTimeout = 20*time.Millisecond, 300*time.Millisecond
	m, rec, _, _ := drainFixture(t)
	c, _ := m.conn("test")
	c.client.(*fake.Clientset).PrependReactor("get", "pods", func(a k8stesting.Action) (bool, runtime.Object, error) {
		if a.(k8stesting.GetAction).GetName() != "slow" {
			return false, nil, nil
		}
		return true, nil, apierrors.NewServiceUnavailable("etcd leader changed")
	})
	if _, err := m.DrainNode("test", "node-1", DrainOptions{}, "jane"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "state unknown", func() bool { return strings.Contains(lastJob(rec).Detail, "1 terminating") })
	waitFor(t, "drain done", func() bool { return lastJob(rec).Done })
	if j := lastJob(rec); !strings.Contains(j.Error, "payments/slow (state unknown)") {
		t.Fatalf("job = %+v", j)
	}
}
