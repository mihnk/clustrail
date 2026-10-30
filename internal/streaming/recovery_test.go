package streaming

import (
	"context"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

// budgetConn accepts a number of frames, then reports a full queue until
// more budget is given: a window whose UI stopped reading mid-snapshot.
type budgetConn struct {
	*fakeConn
	budget atomic.Int64
}

func (b *budgetConn) TrySend(p []byte) error {
	if b.budget.Add(-1) < 0 {
		b.budget.Add(1)
		return ErrFull
	}
	return b.fakeConn.TrySend(p)
}

func TestStallMidSnapshotResumesWithoutResync(t *testing.T) {
	SnapshotChunk = 100
	defer func() { SnapshotChunk = 5000 }()
	m := &manual{sink: make(chan Sink[row], 1)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := NewHub[row](ctx, m.open)
	conn := &budgetConn{fakeConn: &fakeConn{ctx: ctx, in: make(chan []byte, 8)}}
	conn.budget.Store(3) // 3 of the 10 snapshot chunks, then the queue is full
	go Serve(h, conn)
	conn.send(t, ClientMessage{Op: "sub", Sub: "p", Key: Key{Cluster: "a", Kind: "Pod"}})
	s := <-m.sink
	truth := map[string]int{}
	rows := make([]row, 1000)
	for i := range rows {
		rows[i] = row{ID: "r" + itoa(i)}
		truth[rows[i].ID] = 0
	}
	s.Replace(rows)
	waitFor(t, func() bool { return h.Stats.SendFull.Load() > 3 })
	// Changes made during the stall arrive after the rest of the snapshot.
	for i := range 300 {
		s.Upsert(row{ID: "r" + itoa(i), V: i + 1})
		truth["r"+itoa(i)] = i + 1
	}
	time.Sleep(200 * time.Millisecond)
	conn.budget.Store(1 << 30)
	cl := &client{rows: map[string]int{}}
	waitFor(t, func() bool {
		for _, f := range conn.drain() {
			cl.apply(t, f)
		}
		return equal(cl.rows, truth)
	})
	if cl.gaps != 0 || h.Stats.Resyncs.Load() != 0 || h.Stats.Snapshots.Load() != 1 {
		t.Fatalf("gaps %d, resyncs %d, snapshots %d", cl.gaps, h.Stats.Resyncs.Load(), h.Stats.Snapshots.Load())
	}
}

// A cluster whose API answers slowly must not hold back the others.
func TestSlowSourceDoesNotDelayOthers(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := NewHub[row](ctx, func(k Key) (Source[row], error) {
		return func(ctx context.Context, s Sink[row]) {
			s.SetState(Connecting, "")
			if k.Cluster == "slow" {
				select {
				case <-ctx.Done():
					return
				case <-time.After(2 * time.Second):
				}
			}
			s.Replace([]row{{ID: k.Cluster}})
			s.SetState(Live, "")
			<-ctx.Done()
		}, nil
	})
	conn := &fakeConn{ctx: ctx, in: make(chan []byte, 8)}
	go Serve(h, conn)
	start := time.Now()
	conn.send(t, ClientMessage{Op: "sub", Sub: "slow", Key: Key{Cluster: "slow", Kind: "Pod"}})
	conn.send(t, ClientMessage{Op: "sub", Sub: "fast", Key: Key{Cluster: "fast", Kind: "Pod"}})
	got := map[string]time.Duration{}
	waitFor(t, func() bool {
		for _, f := range conn.drain() {
			if f.T == "snap" && len(f.Rows) > 0 { // the first, empty snapshot goes out on subscribe
				got[f.Sub] = time.Since(start)
			}
		}
		return len(got) == 2
	})
	if got["fast"] > 500*time.Millisecond || got["slow"] < 2*time.Second {
		t.Fatalf("snapshot times: %v", got)
	}
}

// Application shutdown: cancelling the hub's context ends every source,
// consumer and connection handler.
func TestShutdownStopsEverything(t *testing.T) {
	before := runtime.NumGoroutine()
	m := &manual{sink: make(chan Sink[row], 64)}
	ctx, cancel := context.WithCancel(context.Background())
	h := NewHub[row](ctx, m.open)
	var served atomic.Int32
	for w := range 3 { // three windows
		conn := &fakeConn{ctx: ctx, in: make(chan []byte, 32)}
		go func() { Serve(h, conn); served.Add(1) }()
		for c := range 20 { // twenty clusters each, shared topics
			conn.send(t, ClientMessage{Op: "sub", Sub: itoa(c), Key: Key{Cluster: itoa(c), Kind: "Pod"}})
		}
		_ = w
	}
	waitFor(t, func() bool { return m.started.Load() == 20 && h.Stats.Consumers.Load() == 60 })
	for range 20 {
		s := <-m.sink
		s.Replace([]row{{ID: "x"}})
		s.Upsert(row{ID: "y"})
	}
	cancel()
	waitFor(t, func() bool { return served.Load() == 3 && m.stopped.Load() == 20 })
	waitFor(t, func() bool { return runtime.NumGoroutine() <= before+1 })
}
