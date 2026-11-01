package kube

import (
	"context"
	"testing"
	"time"

	"go.uber.org/goleak"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/scheme"
)

// noLeaks fails with the stacks of goroutines started since base that are
// still running, after giving them up to 10 s to end (issue D3: Go tests
// fail on a leaked goroutine, whatever its count).
func noLeaks(t *testing.T, base goleak.Option) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		err := goleak.Find(base)
		if err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// Connecting and disconnecting a cluster many times leaves nothing running:
// informers, flush loops, the Helm and GitOps watchers and the metrics loop
// all end with the connection.
func TestConnectDisconnectLeavesNoGoroutines(t *testing.T) {
	warm, _, _ := newFakeConn(t, pod("a", nil))
	ctx, cancel := context.WithCancel(context.Background())
	_ = warm.start(ctx, "tester", true)
	waitFor(t, "warm-up synced", warm.synced)
	cancel()
	warm.stop()
	time.Sleep(200 * time.Millisecond)
	base := goleak.IgnoreCurrent()

	for range 50 {
		c, _, _ := newFakeConn(t, pod("a", nil), &corev1.Node{})
		ctx, cancel := context.WithCancel(context.Background())
		if err := c.start(ctx, "tester", true); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "synced", c.synced)
		cancel()
		c.stop()
	}
	noLeaks(t, base)
}

// Opening and closing log streams leaves no follower or flush loop behind.
func TestLogStreamsLeaveNoGoroutines(t *testing.T) {
	c, _, _ := newFakeConn(t, pod("a", func(p *corev1.Pod) {
		p.Spec.Containers = []corev1.Container{{Name: "app"}}
		p.Status.Phase = corev1.PodRunning
	}))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.ctx = ctx
	m := managerWith(c, false)
	m.streams = streams{logs: map[string]*logStream{}, exec: map[string]*execSession{}}
	time.Sleep(100 * time.Millisecond)
	base := goleak.IgnoreCurrent()
	for range 100 {
		id, err := m.StartLogs(LogsRequest{Cluster: "test", Namespace: "payments", Pods: []string{"a"}})
		if err != nil {
			t.Fatal(err)
		}
		m.StopLogs(id)
	}
	noLeaks(t, base)
}

// Starting and stopping list watches leaves no watch, stream or timer behind.
func TestListWatchesLeaveNoGoroutines(t *testing.T) {
	c, client, _ := newFakeConn(t)
	client.Fake.Resources = []*metav1.APIResourceList{{GroupVersion: "v1", APIResources: []metav1.APIResource{
		{Name: "configmaps", Kind: "ConfigMap", Namespaced: true, Verbs: []string{"list", "watch"}},
	}}}
	c.dynamic = dynamicfake.NewSimpleDynamicClient(scheme.Scheme, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "a", Namespace: "payments"}})
	c.ctx, c.cancel = context.WithCancel(context.Background())
	defer c.cancel()
	m := managerWith(c, false)
	id, err := m.StartListWatch("test", "ConfigMap", "") // discovery and caches warmed up
	if err != nil {
		t.Fatal(err)
	}
	m.StopListWatch(id)
	time.Sleep(200 * time.Millisecond)
	base := goleak.IgnoreCurrent()
	for range 100 {
		id, err := m.StartListWatch("test", "ConfigMap", "")
		if err != nil {
			t.Fatal(err)
		}
		m.StopListWatch(id)
	}
	noLeaks(t, base)
}
