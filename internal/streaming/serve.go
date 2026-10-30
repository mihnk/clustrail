package streaming

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// Conn is the transport (a Wails StreamConn in the app, a fake in tests).
type Conn interface {
	TrySend(data []byte) error
	Receive() ([]byte, error)
	Context() context.Context
}

// ErrFull is what Conn.TrySend returns when the transport has no room.
var ErrFull = errors.New("stream full")

// Tuning. The window adapts between MinWindow and MaxWindow: busy consumers
// batch longer (fewer, larger frames), idle ones answer quickly.
var (
	MinWindow     = 16 * time.Millisecond
	MaxWindow     = 100 * time.Millisecond
	SnapshotChunk = 5000
)

// Frame is the server → client message. Types:
//
//	snap   one chunk of a snapshot (part 0..n, final on the last); replaces the subscription's rows
//	delta  upserts and deletes since the previous frame
//	state  connection state only
//	error  the subscription could not start
//
// Seq increases by one per frame and subscription; a client that sees a gap
// asks for a resync.
type Frame[R Row] struct {
	T       string   `json:"t"`
	Sub     string   `json:"sub"`
	Seq     uint64   `json:"seq"`
	Part    int      `json:"part,omitempty"`
	Final   bool     `json:"final,omitempty"`
	Rows    []R      `json:"rows,omitempty"`
	Upserts []R      `json:"up,omitempty"`
	Deletes []string `json:"del,omitempty"`
	State   State    `json:"state,omitempty"`
	Detail  string   `json:"detail,omitempty"`
	Events  int      `json:"ev,omitempty"`
	// Token identifies the frame in an ack (backend clock, opaque to the client).
	Token int64 `json:"tok,omitempty"`
}

// ClientMessage is the client → server message.
type ClientMessage struct {
	Op  string `json:"op"` // sub, unsub, resync, ack
	Sub string `json:"sub"`
	Key Key    `json:"key"`
	// Ack: the frame token and how long the UI took from receiving it to rendering (UI clock).
	Token int64   `json:"tok,omitempty"`
	UIms  float64 `json:"ui,omitempty"`
}

// Serve runs one client connection: subscriptions arrive as messages, and
// each subscription gets its own sender so one busy scope never delays another.
func Serve[R Row](h *Hub[R], conn Conn) {
	ctx, cancel := context.WithCancel(conn.Context())
	defer cancel()
	var mu sync.Mutex
	subs := map[string]*sender[R]{}
	inflight := &tokens{m: map[int64]sent{}}
	defer func() {
		mu.Lock()
		for _, s := range subs {
			s.stop()
		}
		mu.Unlock()
	}()
	for {
		raw, err := conn.Receive()
		if err != nil {
			return
		}
		var m ClientMessage
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		switch m.Op {
		case "sub":
			slog.Debug("stream subscribe", "sub", m.Sub, "key", m.Key.String())
			mu.Lock()
			if old := subs[m.Sub]; old != nil {
				old.stop()
			}
			c, err := h.Subscribe(m.Key)
			if err != nil {
				mu.Unlock()
				b, _ := json.Marshal(Frame[R]{T: "error", Sub: m.Sub, State: Failed, Detail: err.Error()})
				_ = conn.TrySend(b)
				continue
			}
			s := &sender[R]{id: m.Sub, c: c, conn: conn, stats: h.Stats, tokens: inflight}
			s.ctx, s.cancel = context.WithCancel(ctx)
			subs[m.Sub] = s
			mu.Unlock()
			go s.run()
		case "unsub":
			mu.Lock()
			if s := subs[m.Sub]; s != nil {
				s.stop()
				delete(subs, m.Sub)
			}
			mu.Unlock()
		case "resync":
			mu.Lock()
			if s := subs[m.Sub]; s != nil {
				h.Stats.Resyncs.Add(1)
				s.c.Resync()
			}
			mu.Unlock()
		case "ack":
			inflight.ack(h.Stats, m.Token, m.UIms)
		}
	}
}

type sent struct{ at, oldest time.Time }

var nextToken atomic.Int64

// tokens remembers frames awaiting an ack, to measure round trips on one clock.
type tokens struct {
	mu sync.Mutex
	m  map[int64]sent
}

func (t *tokens) put(tok int64, s sent) {
	t.mu.Lock()
	if len(t.m) > 4096 { // unacked frames (a client that never acks) stay bounded
		t.m = map[int64]sent{}
	}
	t.m[tok] = s
	t.mu.Unlock()
}

func (t *tokens) ack(st *Stats, tok int64, ui float64) {
	t.mu.Lock()
	s, ok := t.m[tok]
	delete(t.m, tok)
	t.mu.Unlock()
	if !ok {
		return
	}
	round := ms(time.Since(s.at))
	st.Round.Add(round)
	st.UI.Add(ui)
	if !s.oldest.IsZero() {
		// Transit each way is unknown; half the round trip without the UI time is the estimate.
		transit := max(0, (round-ui)/2)
		st.Visible.Add(ms(s.at.Sub(s.oldest)) + transit + ui)
	}
}

type sender[R Row] struct {
	id     string
	c      *Consumer[R]
	conn   Conn
	stats  *Stats
	tokens *tokens
	ctx    context.Context
	cancel context.CancelFunc
	seq    uint64
	once   sync.Once
}

func (s *sender[R]) stop() {
	s.once.Do(func() {
		s.cancel()
		s.c.Close()
	})
}

func (s *sender[R]) run() {
	defer s.stop()
	window := MinWindow
	// outbox holds encoded frames the transport refused, in order. They are
	// retried as they are, sequence numbers and all, before anything newer is
	// taken; meanwhile new changes keep folding into the consumer's pending set,
	// which is bounded by the number of rows. Falling behind therefore costs
	// latency, never memory or a resync.
	var outbox [][]byte
	retry := time.NewTimer(time.Hour)
	defer retry.Stop()
	for {
		if len(outbox) == 0 {
			select {
			case <-s.ctx.Done():
				return
			case <-s.c.Ready():
			}
			// Collect for one window: changes to the same row fold together meanwhile.
			select {
			case <-s.ctx.Done():
				return
			case <-time.After(window):
			}
			start := time.Now()
			b := s.c.Take()
			if b.Empty() {
				continue
			}
			if p := int64(len(b.Upserts) + len(b.Deletes)); p > s.stats.MaxPending.Load() {
				s.stats.MaxPending.Store(p)
			}
			outbox = s.encode(b)
			s.stats.Encode.Add(ms(time.Since(start)))
			if !b.Oldest.IsZero() {
				s.stats.Queue.Add(ms(time.Since(b.Oldest)))
			}
			// Adapt: many changes per window → batch longer; few → answer faster.
			switch n := len(b.Upserts) + len(b.Deletes); {
			case n > 2000:
				window = min(window*2, MaxWindow)
			case n < 200:
				window = max(window/2, MinWindow)
			}
		}
		for len(outbox) > 0 {
			if err := s.conn.TrySend(outbox[0]); err != nil {
				break
			}
			s.stats.Frames.Add(1)
			s.stats.Bytes.Add(int64(len(outbox[0])))
			outbox = outbox[1:]
		}
		if len(outbox) > 0 {
			// The window's queue is full: the UI is behind. Try again shortly.
			s.stats.SendFull.Add(1)
			window = MaxWindow
			retry.Reset(10 * time.Millisecond)
			select {
			case <-s.ctx.Done():
				return
			case <-retry.C:
			}
		}
	}
}

// encode turns a batch into frames, numbering them; snapshots are chunked so
// no frame is huge.
func (s *sender[R]) encode(b Batch[R]) [][]byte {
	now := time.Now()
	var out [][]byte
	add := func(f Frame[R]) {
		s.seq++
		f.Sub, f.Seq = s.id, s.seq
		buf, _ := json.Marshal(f)
		out = append(out, buf)
	}
	// A small counter: JSON numbers above 2^53 lose precision in JavaScript.
	tok := nextToken.Add(1)
	if b.Snapshot {
		s.stats.Snapshots.Add(1)
		for part := 0; part == 0 || part*SnapshotChunk < len(b.Rows); part++ {
			end := min(len(b.Rows), (part+1)*SnapshotChunk)
			f := Frame[R]{T: "snap", Part: part, Rows: b.Rows[part*SnapshotChunk : end], Final: end == len(b.Rows), State: b.State, Detail: b.Detail}
			if f.Final {
				f.Token = tok
			}
			add(f)
		}
		s.tokens.put(tok, sent{at: now})
		return out
	}
	if len(b.Upserts)+len(b.Deletes) == 0 {
		add(Frame[R]{T: "state", State: b.State, Detail: b.Detail})
		return out
	}
	s.stats.Size.Add(float64(len(b.Upserts) + len(b.Deletes)))
	f := Frame[R]{T: "delta", Upserts: b.Upserts, Deletes: b.Deletes, Events: b.Events, Token: tok}
	if b.StateDirty {
		f.State, f.Detail = b.State, b.Detail
	}
	add(f)
	s.tokens.put(tok, sent{at: now, oldest: b.Oldest})
	return out
}
