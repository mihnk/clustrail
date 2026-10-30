package streaming

import (
	"context"
	"encoding/json"
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type row struct {
	ID string `json:"id"`
	V  int    `json:"v"`
}

func (r row) RowID() string { return r.ID }

// manual is a source driven by the test.
type manual struct {
	sink    chan Sink[row]
	started atomic.Int32
	stopped atomic.Int32
}

func (m *manual) open(Key) (Source[row], error) {
	return func(ctx context.Context, s Sink[row]) {
		m.started.Add(1)
		m.sink <- s
		<-ctx.Done()
		m.stopped.Add(1)
	}, nil
}

func TestCoalescingKeepsFinalStateAndDeletes(t *testing.T) {
	m := &manual{sink: make(chan Sink[row], 1)}
	h := NewHub[row](context.Background(), m.open)
	c, err := h.Subscribe(Key{Cluster: "a", Kind: "Pod"})
	if err != nil {
		t.Fatal(err)
	}
	s := <-m.sink
	s.Replace([]row{{"x", 1}, {"y", 1}})
	if b := c.Take(); !b.Snapshot || len(b.Rows) != 2 {
		t.Fatalf("first batch = %+v", b)
	}
	s.Upsert(row{"x", 2})
	s.Upsert(row{"x", 3}) // folds into one
	s.Delete("y")
	s.Upsert(row{"z", 1})
	s.Delete("z") // added then deleted: the delete is kept
	s.Delete("w")
	s.Upsert(row{"w", 9}) // deleted then re-created: the upsert wins
	b := c.Take()
	if b.Events != 7 {
		t.Fatalf("events = %d", b.Events)
	}
	up := map[string]int{}
	for _, r := range b.Upserts {
		up[r.ID] = r.V
	}
	del := map[string]bool{}
	for _, id := range b.Deletes {
		del[id] = true
	}
	if len(up) != 2 || up["x"] != 3 || up["w"] != 9 || len(del) != 2 || !del["y"] || !del["z"] {
		t.Fatalf("up=%v del=%v", up, del)
	}
	// A failed send puts the batch back; newer changes still win.
	s.Upsert(row{"x", 4})
	c.Return(b)
	b2 := c.Take()
	for _, r := range b2.Upserts {
		if r.ID == "x" && r.V != 4 {
			t.Fatalf("returned batch overwrote a newer change: %+v", r)
		}
	}
	// A re-list resynchronizes consumers with a snapshot.
	s.Replace([]row{{"x", 5}})
	if b := c.Take(); !b.Snapshot || len(b.Rows) != 1 {
		t.Fatalf("after replace = %+v", b)
	}
	c.Close()
}

func TestTopicsAreSharedAndStopWithTheLastConsumer(t *testing.T) {
	m := &manual{sink: make(chan Sink[row], 2)}
	h := NewHub[row](context.Background(), m.open)
	k := Key{Cluster: "a", Kind: "Pod", Namespace: "payments"}
	c1, _ := h.Subscribe(k)
	c2, _ := h.Subscribe(k)
	c3, _ := h.Subscribe(Key{Cluster: "b", Kind: "Pod"})
	waitFor(t, func() bool { return m.started.Load() == 2 })
	if len(h.Topics()) != 2 {
		t.Fatalf("topics = %v", h.Topics())
	}
	c1.Close()
	c1.Close() // idempotent
	time.Sleep(20 * time.Millisecond)
	if m.stopped.Load() != 0 {
		t.Fatal("source stopped while a consumer remained")
	}
	c2.Close()
	c3.Close()
	waitFor(t, func() bool { return m.stopped.Load() == 2 })
	if len(h.Topics()) != 0 || h.Stats.Consumers.Load() != 0 {
		t.Fatalf("leftovers: topics=%v consumers=%d", h.Topics(), h.Stats.Consumers.Load())
	}
}

// fakeConn is a transport with a bounded queue, like the Wails window queue.
type fakeConn struct {
	ctx    context.Context
	in     chan []byte
	mu     sync.Mutex
	frames [][]byte
	full   atomic.Bool
}

func (f *fakeConn) TrySend(b []byte) error {
	if f.full.Load() {
		return ErrFull
	}
	f.mu.Lock()
	f.frames = append(f.frames, b)
	f.mu.Unlock()
	return nil
}
func (f *fakeConn) Receive() ([]byte, error) {
	select {
	case b := <-f.in:
		return b, nil
	case <-f.ctx.Done():
		return nil, errors.New("closed")
	}
}
func (f *fakeConn) Context() context.Context { return f.ctx }
func (f *fakeConn) send(t *testing.T, m ClientMessage) {
	b, _ := json.Marshal(m)
	f.in <- b
}
func (f *fakeConn) drain() []Frame[row] {
	f.mu.Lock()
	raw := f.frames
	f.frames = nil
	f.mu.Unlock()
	out := make([]Frame[row], len(raw))
	for i, b := range raw {
		_ = json.Unmarshal(b, &out[i])
	}
	return out
}

// client applies frames the way the UI does, checking sequence numbers.
type client struct {
	rows    map[string]int
	staging map[string]int
	seq     uint64
	gaps    int
}

func (c *client) apply(t *testing.T, f Frame[row]) {
	if f.T == "snap" && f.Part == 0 {
		c.staging = map[string]int{}
	} else if f.Seq != c.seq+1 {
		c.gaps++
	}
	c.seq = f.Seq
	switch f.T {
	case "snap":
		for _, r := range f.Rows {
			c.staging[r.ID] = r.V
		}
		if f.Final {
			c.rows = c.staging
		}
	case "delta":
		for _, r := range f.Upserts {
			c.rows[r.ID] = r.V
		}
		for _, id := range f.Deletes {
			delete(c.rows, id)
		}
	}
}

func TestServeStaysConsistentUnderLoadAndBackpressure(t *testing.T) {
	before := runtime.NumGoroutine()
	SnapshotChunk = 100
	defer func() { SnapshotChunk = 5000 }()
	m := &manual{sink: make(chan Sink[row], 1)}
	ctx, cancel := context.WithCancel(context.Background())
	h := NewHub[row](ctx, m.open)
	conn := &fakeConn{ctx: ctx, in: make(chan []byte, 8)}
	done := make(chan struct{})
	go func() { Serve(h, conn); close(done) }()
	conn.send(t, ClientMessage{Op: "sub", Sub: "p", Key: Key{Cluster: "a", Kind: "Pod"}})
	s := <-m.sink

	truth := map[string]int{}
	initial := make([]row, 0, 1000)
	for i := range 1000 {
		r := row{ID: "r" + itoa(i), V: 0}
		truth[r.ID] = 0
		initial = append(initial, r)
	}
	s.Replace(initial)

	cl := &client{rows: map[string]int{}}
	// 20k changes with a stall in the middle: sends fail, the backlog folds, nothing is lost.
	for i := range 20000 {
		id := "r" + itoa(i%1200)
		switch {
		case i%7 == 0:
			s.Delete(id)
			delete(truth, id)
		default:
			s.Upsert(row{id, i})
			truth[id] = i
		}
		if i == 8000 {
			conn.full.Store(true)
		}
		if i == 12000 {
			// Hold the stall until the sender has hit it at least once.
			waitFor(t, func() bool { return h.Stats.SendFull.Load() > 0 })
			conn.full.Store(false)
		}
		if i%500 == 0 {
			for _, f := range conn.drain() {
				cl.apply(t, f)
			}
			time.Sleep(time.Millisecond)
		}
	}
	waitFor(t, func() bool {
		for _, f := range conn.drain() {
			cl.apply(t, f)
		}
		return len(cl.rows) == len(truth) && equal(cl.rows, truth)
	})
	if cl.gaps != 0 {
		t.Fatalf("sequence gaps: %d", cl.gaps)
	}
	if h.Stats.SendFull.Load() == 0 {
		t.Fatal("the stall was not exercised")
	}
	if n := h.Stats.Resyncs.Load() + h.Stats.Snapshots.Load(); n != 1 {
		t.Fatalf("a stall cost %d snapshots/resyncs; want only the first snapshot", n)
	}
	cancel()
	<-done
	waitFor(t, func() bool { return runtime.NumGoroutine() <= before+1 })
}

func equal(a, b map[string]int) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if bv, ok := b[k]; !ok || bv != v {
			return false
		}
	}
	return true
}

func itoa(i int) string {
	return string(rune('a'+i%26)) + string(rune('a'+(i/26)%26)) + string(rune('a'+(i/676)%26))
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met within 5s")
}

func TestRepeatedSubscribeUnsubscribeLeaksNothing(t *testing.T) {
	before := runtime.NumGoroutine()
	m := &manual{sink: make(chan Sink[row], 1)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := NewHub[row](ctx, m.open)
	conn := &fakeConn{ctx: ctx, in: make(chan []byte)}
	go Serve(h, conn)
	for i := range 200 {
		conn.send(t, ClientMessage{Op: "sub", Sub: "p", Key: Key{Cluster: "a", Kind: "Pod", Namespace: itoa(i % 3)}})
		<-m.sink
		conn.send(t, ClientMessage{Op: "unsub", Sub: "p"})
	}
	waitFor(t, func() bool { return m.stopped.Load() == 200 && len(h.Topics()) == 0 && h.Stats.Consumers.Load() == 0 })
	cancel()
	waitFor(t, func() bool { return runtime.NumGoroutine() <= before+1 })
}

func TestResyncAndAckMeasureOnOneClock(t *testing.T) {
	m := &manual{sink: make(chan Sink[row], 1)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := NewHub[row](ctx, m.open)
	conn := &fakeConn{ctx: ctx, in: make(chan []byte, 4)}
	go Serve(h, conn)
	conn.send(t, ClientMessage{Op: "sub", Sub: "p", Key: Key{Cluster: "a", Kind: "Pod"}})
	s := <-m.sink
	s.Replace([]row{{"x", 1}})
	var frames []Frame[row]
	waitFor(t, func() bool { frames = append(frames, conn.drain()...); return len(frames) > 0 })
	s.Upsert(row{"x", 2})
	waitFor(t, func() bool { frames = append(frames, conn.drain()...); return frames[len(frames)-1].T == "delta" })
	d := frames[len(frames)-1]
	conn.send(t, ClientMessage{Op: "ack", Sub: "p", Token: d.Token, UIms: 3})
	waitFor(t, func() bool { return h.Stats.Visible.Summary().N == 1 })
	if v := h.Stats.Visible.Summary(); v.P50 < 3 {
		t.Fatalf("visible estimate %v must include the UI time", v)
	}
	conn.send(t, ClientMessage{Op: "resync", Sub: "p"})
	waitFor(t, func() bool {
		for _, f := range conn.drain() {
			if f.T == "snap" && f.Final && len(f.Rows) == 1 && f.Rows[0].V == 2 {
				return true
			}
		}
		return false
	})
}
