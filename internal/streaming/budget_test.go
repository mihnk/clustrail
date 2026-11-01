package streaming

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// countingConn counts every send attempt, accepted or refused.
type countingConn struct {
	*fakeConn
	attempts atomic.Int64
}

func (c *countingConn) TrySend(p []byte) error {
	c.attempts.Add(1)
	return c.fakeConn.TrySend(p)
}

// A window that stopped reading while pods come and go with new names: the
// queue stays bounded, and once the window reads again it ends with exactly
// the source's rows (no ghost from a dropped delete).
func TestStalledConsumerStaysBoundedThroughChurn(t *testing.T) {
	oldMax := MaxPending
	MaxPending = 500
	defer func() { MaxPending = oldMax }()
	m := &manual{sink: make(chan Sink[row], 1)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := NewHub[row](ctx, m.open)
	conn := &fakeConn{ctx: ctx, in: make(chan []byte, 8)}
	go Serve(h, conn)
	conn.send(t, ClientMessage{Op: "sub", Sub: "p", Key: Key{Cluster: "a", Kind: "Pod"}})
	s := <-m.sink
	truth := map[string]int{}
	stable := make([]row, 100)
	for i := range stable {
		stable[i] = row{ID: "stable-" + itoa(i)}
		truth[stable[i].ID] = 0
	}
	s.Replace(stable)
	cl := &client{rows: map[string]int{}}
	waitFor(t, func() bool {
		for _, f := range conn.drain() {
			cl.apply(t, f)
		}
		return equal(cl.rows, truth)
	})

	conn.full.Store(true) // the window stops reading
	peak := 0
	for i := range 20_000 {
		id := "job-" + itoa(i)
		s.Upsert(row{ID: id, V: 1})
		s.Delete(id)
		if i%7 == 0 {
			s.Upsert(row{ID: stable[i%100].ID, V: i})
			truth[stable[i%100].ID] = i
		}
		if i%100 == 0 {
			peak = max(peak, h.Pending())
		}
	}
	peak = max(peak, h.Pending())
	if peak > 2*MaxPending {
		t.Fatalf("pending peaked at %d, bound is about %d", peak, MaxPending)
	}
	if h.Stats.Overflows.Load() == 0 {
		t.Fatal("the queue should have overflowed into a snapshot")
	}
	conn.full.Store(false)
	waitFor(t, func() bool {
		for _, f := range conn.drain() {
			cl.apply(t, f)
		}
		return equal(cl.rows, truth)
	})
	if cl.gaps != 0 {
		t.Fatalf("sequence gaps: %d", cl.gaps)
	}
}

// Many changes at once go out in bounded frames, in order, and converge.
func TestLargeDeltasAreSplitIntoFrames(t *testing.T) {
	SnapshotChunk = 1000
	defer func() { SnapshotChunk = 5000 }()
	m := &manual{sink: make(chan Sink[row], 1)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := NewHub[row](ctx, m.open)
	conn := &fakeConn{ctx: ctx, in: make(chan []byte, 8)}
	go Serve(h, conn)
	conn.send(t, ClientMessage{Op: "sub", Sub: "p", Key: Key{Cluster: "a", Kind: "Pod"}})
	s := <-m.sink
	s.Replace(nil)
	cl := &client{rows: map[string]int{}}
	waitFor(t, func() bool {
		for _, f := range conn.drain() {
			cl.apply(t, f)
		}
		return cl.seq > 0
	})
	conn.full.Store(true) // let one large batch build up
	truth := map[string]int{}
	for i := range 4500 {
		s.Upsert(row{ID: "r" + itoa(i), V: i})
		truth["r"+itoa(i)] = i
	}
	time.Sleep(150 * time.Millisecond)
	conn.full.Store(false)
	largest, tokens := 0, 0
	waitFor(t, func() bool {
		for _, f := range conn.drain() {
			largest = max(largest, len(f.Upserts)+len(f.Deletes))
			if f.Token != 0 {
				tokens++
			}
			cl.apply(t, f)
		}
		return equal(cl.rows, truth)
	})
	if largest > SnapshotChunk {
		t.Fatalf("a frame carried %d changes, limit %d", largest, SnapshotChunk)
	}
	if cl.gaps != 0 {
		t.Fatalf("gaps: %d", cl.gaps)
	}
}

func TestSubscriptionsPerConnectionAreLimited(t *testing.T) {
	old := MaxSubscriptions
	MaxSubscriptions = 3
	defer func() { MaxSubscriptions = old }()
	m := &manual{sink: make(chan Sink[row], 8)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := NewHub[row](ctx, m.open)
	conn := &fakeConn{ctx: ctx, in: make(chan []byte, 8)}
	go Serve(h, conn)
	for i := range 4 {
		conn.send(t, ClientMessage{Op: "sub", Sub: "s" + itoa(i), Key: Key{Cluster: "c" + itoa(i), Kind: "Pod"}})
	}
	var refused []Frame[row]
	waitFor(t, func() bool {
		for _, f := range conn.drain() {
			if f.T == "error" {
				refused = append(refused, f)
			}
		}
		return len(refused) == 1
	})
	if refused[0].Sub != "s"+itoa(3) {
		t.Fatalf("refused %q", refused[0].Sub)
	}
	// Replacing an existing subscription is not a new one.
	conn.send(t, ClientMessage{Op: "sub", Sub: "s" + itoa(0), Key: Key{Cluster: "x", Kind: "Pod"}})
	time.Sleep(50 * time.Millisecond)
	for _, f := range conn.drain() {
		if f.T == "error" {
			t.Fatalf("re-subscribing s0 was refused: %s", f.Detail)
		}
	}
}

// A window that stopped reading costs a few attempts a second, not a busy loop.
func TestAFullTransportIsRetriedWithBackoff(t *testing.T) {
	m := &manual{sink: make(chan Sink[row], 1)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := NewHub[row](ctx, m.open)
	conn := &countingConn{fakeConn: &fakeConn{ctx: ctx, in: make(chan []byte, 8)}}
	conn.full.Store(true)
	go Serve(h, conn)
	conn.send(t, ClientMessage{Op: "sub", Sub: "p", Key: Key{Cluster: "a", Kind: "Pod"}})
	s := <-m.sink
	s.Replace([]row{{ID: "a"}})
	time.Sleep(2 * time.Second)
	if n := conn.attempts.Load(); n > 20 {
		t.Fatalf("%d send attempts in 2 s while the window was full", n)
	}
	conn.full.Store(false)
	waitFor(t, func() bool { return len(conn.drain()) > 0 })
}

// Closing the last consumer frees the scope's rows.
func TestAClosedScopeFreesItsRows(t *testing.T) {
	m := &manual{sink: make(chan Sink[row], 1)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := NewHub[row](ctx, m.open)
	c, err := h.Subscribe(Key{Cluster: "a", Kind: "Pod"})
	if err != nil {
		t.Fatal(err)
	}
	s := <-m.sink
	rows := make([]row, 5000)
	for i := range rows {
		rows[i] = row{ID: "r" + itoa(i)}
	}
	s.Replace(rows)
	if h.Rows() != 5000 {
		t.Fatalf("rows = %d", h.Rows())
	}
	c.Close()
	if h.Rows() != 0 || len(h.Topics()) != 0 {
		t.Fatalf("after close: %d rows in %d topics", h.Rows(), len(h.Topics()))
	}
}
