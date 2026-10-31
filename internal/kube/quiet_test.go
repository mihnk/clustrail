package kube

import (
	"context"

	appsv1 "k8s.io/api/apps/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sync/atomic"
	"testing"
	"time"
)

// A flush loop with nothing to send stops waking; a kick brings it back
// within one interval, and a kick that came while it was busy is not lost.
func TestFlushUntilQuietSleepsAndWakesOnKick(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	k := newKicker()
	var work, flushes atomic.Int32
	go flushUntilQuiet(ctx, "test quiet loop", 10*time.Millisecond, k, func() bool {
		flushes.Add(1)
		return work.Swap(0) > 0
	})
	time.Sleep(150 * time.Millisecond)
	idle := flushes.Load()
	if idle != quietAfter {
		t.Fatalf("flushes before going quiet = %d, want %d", idle, quietAfter)
	}
	time.Sleep(150 * time.Millisecond)
	if flushes.Load() != idle {
		t.Fatal("a quiet loop must not wake")
	}
	work.Store(1)
	k.kick()
	waitFor(t, "flush after a kick", func() bool { return flushes.Load() > idle })
	// Kicked while busy: the kick waits in the buffer, the loop does not sleep through it.
	k.kick()
	k.kick() // never blocks
	time.Sleep(150 * time.Millisecond)
	after := flushes.Load()
	time.Sleep(100 * time.Millisecond)
	if flushes.Load() != after {
		t.Fatal("the loop must go quiet again")
	}
}

// A connected cluster with nothing changing stops its row flush; a change
// is sent within one flush interval.
func TestClusterFlushGoesQuietAndSendsChanges(t *testing.T) {
	c, client, rec := newFakeConn(t, pod("a", nil))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := c.start(ctx, "tester", false); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "first reset", func() bool { return len(rec.deltas("pods")) > 0 || len(rec.deltas("deployments")) > 0 })
	time.Sleep(flushInterval * (quietAfter + 2))
	w := Wakeups()["cluster flush"]
	time.Sleep(3 * flushInterval)
	if d := Wakeups()["cluster flush"] - w; d > 0 {
		t.Fatalf("an idle cluster woke %d times", d)
	}
	before := len(rec.deltas("deployments"))
	_, _ = client.AppsV1().Deployments("payments").Create(ctx, deployment(func(d *appsv1.Deployment) { d.Name, d.UID = "web", "web-uid" }), metav1.CreateOptions{})
	waitFor(t, "the change sent", func() bool { return len(rec.deltas("deployments")) > before })
}
