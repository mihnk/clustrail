package kube

import (
	"context"
	"runtime"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/scheme"
)

// goroutinesSettle waits until the number of goroutines is back to at most
// base+slack, and fails with the stacks of the extra ones if it is not.
func goroutinesSettle(t *testing.T, base, slack int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		runtime.GC()
		n := runtime.NumGoroutine()
		if n <= base+slack {
			return
		}
		if time.Now().After(deadline) {
			buf := make([]byte, 1<<20)
			stacks := string(buf[:runtime.Stack(buf, true)])
			// Only the stacks that run Clustrail's code: the leak's owner.
			var ours []string
			for _, g := range strings.Split(stacks, "\n\n") {
				if strings.Contains(g, "clustrail/internal") && !strings.Contains(g, "goroutinesSettle") && !strings.Contains(g, "testing.tRunner") {
					ours = append(ours, g)
				}
			}
			t.Fatalf("%d goroutines, %d at the start (+%d allowed); still running:\n%s", n, base, slack, strings.Join(ours, "\n\n"))
		}
		time.Sleep(50 * time.Millisecond)
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
	runtime.GC()
	base := runtime.NumGoroutine()

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
	goroutinesSettle(t, base, 3)
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
	runtime.GC()
	base := runtime.NumGoroutine()
	for range 100 {
		id, err := m.StartLogs(LogsRequest{Cluster: "test", Namespace: "payments", Pods: []string{"a"}})
		if err != nil {
			t.Fatal(err)
		}
		m.StopLogs(id)
	}
	goroutinesSettle(t, base, 3)
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
	runtime.GC()
	base := runtime.NumGoroutine()
	for range 100 {
		id, err := m.StartListWatch("test", "ConfigMap", "")
		if err != nil {
			t.Fatal(err)
		}
		m.StopListWatch(id)
	}
	goroutinesSettle(t, base, 3)
}
