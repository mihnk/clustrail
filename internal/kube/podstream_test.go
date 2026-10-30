package kube

import (
	"context"
	"net/url"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/watch"
	k8stesting "k8s.io/client-go/testing"

	"github.com/mihnk/clustrail/internal/streaming"
)

func TestPodSourceUsesTheConnectionInformer(t *testing.T) {
	c, client, _ := newFakeConn(t, pod("a", nil), pod("b", nil))
	c.streamPods = true
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := c.start(ctx, "tester", false); err != nil {
		t.Fatal(err)
	}
	m := managerWith(c, false)
	m.state["test"].Connection = Connected
	hub := streaming.NewHub[PodRow](ctx, m.PodSource)
	sub, err := hub.Subscribe(streaming.Key{Cluster: "test", Kind: "Pod"})
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close()
	var seen []streaming.Batch[PodRow] // every batch so far: a state can ride along with an earlier batch
	take := func(what string, ok func(streaming.Batch[PodRow]) bool) {
		t.Helper()
		waitFor(t, what, func() bool {
			b := sub.Take()
			if !b.Empty() {
				seen = append(seen, b)
			}
			for _, b := range seen {
				if ok(b) {
					return true
				}
			}
			return false
		})
	}
	take("snapshot", func(b streaming.Batch[PodRow]) bool { return b.Snapshot && len(b.Rows) == 2 })
	take("live", func(b streaming.Batch[PodRow]) bool { return b.State == streaming.Live })

	if _, err := client.CoreV1().Pods("payments").Create(ctx, pod("c", nil), metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	take("upsert of c", func(b streaming.Batch[PodRow]) bool {
		return len(b.Upserts) == 1 && b.Upserts[0].ID == "test/payments/c"
	})
	if err := client.CoreV1().Pods("payments").Delete(ctx, "a", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	take("delete of a", func(b streaming.Batch[PodRow]) bool { return len(b.Deletes) == 1 && b.Deletes[0] == "test/payments/a" })

	// The pod informer stays the only watch, and no pod deltas go out as events.
	watches := 0
	for _, a := range client.Actions() {
		if a.GetVerb() == "watch" && a.GetResource().Resource == "pods" {
			watches++
		}
	}
	if watches != 1 {
		t.Fatalf("pod watches = %d", watches)
	}

	// Disconnect: the scope reports it instead of going quiet.
	m.mu.Lock()
	delete(m.conns, "test")
	m.mu.Unlock()
	c.stop()
	take("disconnected", func(b streaming.Batch[PodRow]) bool { return b.State == streaming.Disconnected })
}

// The pod stream through API failures: an expired resourceVersion (410 Gone)
// re-lists and the rows converge on the server's; a lost connection and
// expired credentials mark the scope stale while keeping its rows; a
// successful probe brings it back to live with the server's current pods.
func TestPodStreamRecoversFromWatchFailures(t *testing.T) {
	c, client, _ := newFakeConn(t, pod("a", nil), pod("b", nil))
	c.streamPods = true
	watchers := make(chan *watch.FakeWatcher, 8)
	var failure atomic.Pointer[error] // returned by list and watch while set
	fail := func(err error) { failure.Store(&err) }
	failing := func() error {
		if e := failure.Load(); e != nil {
			return *e
		}
		return nil
	}
	client.PrependWatchReactor("pods", func(k8stesting.Action) (bool, watch.Interface, error) {
		if err := failing(); err != nil {
			return true, nil, err
		}
		w := watch.NewFakeWithChanSize(16, false)
		watchers <- w
		return true, w, nil
	})
	client.PrependReactor("list", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		if err := failing(); err != nil {
			return true, nil, err
		}
		return false, nil, nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var err error
	m := managerWith(c, false)
	m.attempts = map[string]int{}
	m.kc = &Kubeconfig{}
	if m.store, err = OpenStore(filepath.Join(t.TempDir(), "contexts.json")); err != nil {
		t.Fatal(err)
	}
	m.state["test"].Connection = Connected
	c.onState = func(s ConnectionState, err error) { m.onConnState("test", s, err) }
	if err := c.start(ctx, "tester", false); err != nil {
		t.Fatal(err)
	}
	defer c.stop()
	hub := streaming.NewHub[PodRow](ctx, m.PodSource)
	sub, err := hub.Subscribe(streaming.Key{Cluster: "test", Kind: "Pod"})
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close()

	// The UI's view: rows and state, folded from batches.
	rows := map[string]PodRow{}
	state := streaming.State("")
	pull := func() {
		b := sub.Take()
		if b.Snapshot {
			rows = map[string]PodRow{}
			for _, r := range b.Rows {
				rows[r.ID] = r
			}
		}
		for _, r := range b.Upserts {
			rows[r.ID] = r
		}
		for _, id := range b.Deletes {
			delete(rows, id)
		}
		if b.StateDirty {
			state = b.State
		}
	}
	until := func(what string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			pull()
			if cond() {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("timed out waiting for %s (state %q, rows %v)", what, state, keys(rows))
	}
	has := func(names ...string) func() bool {
		return func() bool {
			if len(rows) != len(names) {
				return false
			}
			for _, n := range names {
				if _, ok := rows["test/payments/"+n]; !ok {
					return false
				}
			}
			return true
		}
	}

	until("initial rows, live", func() bool { return has("a", "b")() && state == streaming.Live })
	w := <-watchers
	w.Add(pod("c", nil))
	until("watched add", has("a", "b", "c"))

	// 410 Gone: the server forgot our resourceVersion. Meanwhile c went away
	// and d appeared, both unseen; the re-list must reconcile both.
	if err := client.Tracker().Add(pod("d", nil)); err != nil {
		t.Fatal(err)
	}
	w.Error(&metav1.Status{Status: metav1.StatusFailure, Code: 410, Reason: metav1.StatusReasonExpired, Message: "too old resource version"})
	until("re-list after 410", has("a", "b", "d"))
	if state != streaming.Live {
		t.Fatalf("410 is routine, state = %q", state)
	}
	w = <-watchers

	// Network loss, then expired credentials: rows stay, the scope goes stale.
	fail(&url.Error{Op: "Get", URL: "https://api", Err: syscall.ECONNREFUSED})
	w.Stop()
	until("stale on network loss", func() bool { return state == streaming.Stale && has("a", "b", "d")() })
	fail(apierrors.NewUnauthorized("token expired"))
	time.Sleep(1500 * time.Millisecond) // a few failed re-lists
	if !has("a", "b", "d")() || state != streaming.Stale {
		t.Fatalf("while failing: state %q rows %v", state, keys(rows))
	}

	// Back: e was created and a deleted while we could not see.
	if err := client.Tracker().Add(pod("e", nil)); err != nil {
		t.Fatal(err)
	}
	if err := client.Tracker().Delete(corev1.SchemeGroupVersion.WithResource("pods"), "payments", "a"); err != nil {
		t.Fatal(err)
	}
	fail(nil)
	until("rows after recovery", has("b", "d", "e"))
	m.onProbe("test", 3, nil)
	until("live after a good probe", func() bool { return state == streaming.Live })
}

func keys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
