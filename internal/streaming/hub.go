// Package streaming moves resource tables from Kubernetes (or the synthetic
// provider) to the UI incrementally. A Hub shares one source per subscription
// key; every consumer gets its own coalescing queue, so a slow window never
// holds up the source or other consumers, and its memory is bounded by the
// number of resources rather than the number of events.
package streaming

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Row is a table projection with a stable identity.
type Row interface{ RowID() string }

// Key identifies one subscription scope. Consumers with equal keys share a source.
type Key struct {
	Cluster   string `json:"cluster"`
	Kind      string `json:"kind"`
	Namespace string `json:"namespace,omitempty"`
	Selector  string `json:"selector,omitempty"`
}

func (k Key) String() string {
	return fmt.Sprintf("%s/%s/%s?%s", k.Cluster, k.Kind, k.Namespace, k.Selector)
}

// State of a subscription as the UI shows it. Rows of a stale or
// disconnected subscription are kept but must not be presented as live.
type State string

const (
	Connecting   State = "connecting"
	Live         State = "live"
	Stale        State = "stale"
	Disconnected State = "disconnected"
	Failed       State = "error"
)

// Sink receives a source's changes. Replace is a full list (initial list or re-list).
type Sink[R Row] interface {
	Replace(rows []R)
	Upsert(row R)
	Delete(id string)
	SetState(s State, detail string)
}

// Source produces one scope's rows until ctx ends.
type Source[R Row] func(ctx context.Context, sink Sink[R])

// Opener returns the source for a key, or an error (unknown cluster, RBAC…).
type Opener[R Row] func(Key) (Source[R], error)

// Hub owns the topics. Safe for concurrent use.
type Hub[R Row] struct {
	ctx    context.Context
	open   Opener[R]
	Stats  *Stats
	mu     sync.Mutex
	topics map[Key]*topic[R]
}

func NewHub[R Row](ctx context.Context, open Opener[R]) *Hub[R] {
	return &Hub[R]{ctx: ctx, open: open, Stats: &Stats{}, topics: map[Key]*topic[R]{}}
}

// Subscribe attaches a consumer to the key's topic, starting the source on
// first use. The consumer's first batch is a snapshot.
func (h *Hub[R]) Subscribe(key Key) (*Consumer[R], error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	t := h.topics[key]
	if t == nil {
		src, err := h.open(key)
		if err != nil {
			return nil, err
		}
		ctx, cancel := context.WithCancel(h.ctx)
		t = &topic[R]{key: key, hub: h, rows: map[string]R{}, state: Connecting, consumers: map[*Consumer[R]]struct{}{}, cancel: cancel}
		h.topics[key] = t
		h.Stats.Topics.Add(1)
		go src(ctx, t)
	}
	c := &Consumer[R]{topic: t, notify: make(chan struct{}, 1), pending: map[string]op[R]{}, snapshot: true}
	t.mu.Lock()
	t.consumers[c] = struct{}{}
	c.state, c.detail = t.state, t.err
	t.mu.Unlock()
	h.Stats.Consumers.Add(1)
	c.signal()
	return c, nil
}

// Topics reports the active subscription keys (diagnostics).
func (h *Hub[R]) Topics() []Key {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]Key, 0, len(h.topics))
	for k := range h.topics {
		out = append(out, k)
	}
	return out
}

// Rows counts cached rows over all topics (diagnostics).
func (h *Hub[R]) Rows() int {
	h.mu.Lock()
	ts := make([]*topic[R], 0, len(h.topics))
	for _, t := range h.topics {
		ts = append(ts, t)
	}
	h.mu.Unlock()
	n := 0
	for _, t := range ts {
		t.mu.Lock()
		n += len(t.rows)
		t.mu.Unlock()
	}
	return n
}

func (h *Hub[R]) release(t *topic[R], c *Consumer[R]) {
	h.mu.Lock()
	t.mu.Lock()
	delete(t.consumers, c)
	last := len(t.consumers) == 0
	t.mu.Unlock()
	if last && h.topics[t.key] == t {
		delete(h.topics, t.key)
		h.Stats.Topics.Add(-1)
		t.cancel() // no one watches this scope any more: stop the source
	}
	h.mu.Unlock()
	h.Stats.Consumers.Add(-1)
}

// topic is one shared scope: the authoritative projection rows (for
// snapshots) and the consumers to fan changes out to.
type topic[R Row] struct {
	key       Key
	hub       *Hub[R]
	cancel    context.CancelFunc
	mu        sync.Mutex
	rows      map[string]R
	state     State
	err       string
	consumers map[*Consumer[R]]struct{}
}

func (t *topic[R]) Replace(rows []R) {
	now := time.Now()
	t.mu.Lock()
	next := make(map[string]R, len(rows))
	for _, r := range rows {
		next[r.RowID()] = r
	}
	t.rows = next
	for c := range t.consumers {
		c.mu.Lock()
		// A re-list may have missed deletions: consumers resynchronize.
		c.snapshot, c.pending = true, map[string]op[R]{}
		c.mark(now)
		c.mu.Unlock()
		c.signal()
	}
	t.mu.Unlock()
	t.hub.Stats.Events.Add(int64(len(rows)))
}

func (t *topic[R]) Upsert(r R) {
	now := time.Now()
	id := r.RowID()
	t.mu.Lock()
	t.rows[id] = r
	for c := range t.consumers {
		c.mu.Lock()
		if !c.snapshot {
			c.pending[id] = op[R]{row: r}
			c.events++
			c.mark(now)
		}
		c.mu.Unlock()
		c.signal()
	}
	t.mu.Unlock()
	t.hub.Stats.Events.Add(1)
}

func (t *topic[R]) Delete(id string) {
	now := time.Now()
	t.mu.Lock()
	delete(t.rows, id)
	for c := range t.consumers {
		c.mu.Lock()
		if !c.snapshot {
			// Never dropped: a lost delete would leave a ghost row in the UI.
			c.pending[id] = op[R]{del: true}
			c.events++
			c.mark(now)
		}
		c.mu.Unlock()
		c.signal()
	}
	t.mu.Unlock()
	t.hub.Stats.Events.Add(1)
}

func (t *topic[R]) SetState(s State, detail string) {
	now := time.Now()
	t.mu.Lock()
	t.state, t.err = s, detail
	for c := range t.consumers {
		c.mu.Lock()
		c.state, c.detail, c.stateDirty = s, detail, true
		c.mark(now)
		c.mu.Unlock()
		c.signal()
	}
	t.mu.Unlock()
}

type op[R Row] struct {
	row R
	del bool
}

// Consumer is one subscriber's view of a topic: changes not yet sent,
// coalesced per row (last write wins; a delete is never lost).
type Consumer[R Row] struct {
	topic  *topic[R]
	notify chan struct{}

	mu         sync.Mutex
	pending    map[string]op[R]
	snapshot   bool // the next batch is a full snapshot
	state      State
	detail     string
	stateDirty bool
	events     int       // raw events folded into pending
	oldest     time.Time // when the oldest pending change arrived
	closed     bool
}

func (c *Consumer[R]) mark(now time.Time) {
	if c.oldest.IsZero() {
		c.oldest = now
	}
}

func (c *Consumer[R]) signal() {
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

// Key is the consumer's subscription key.
func (c *Consumer[R]) Key() Key { return c.topic.key }

// Ready is signalled when there is something to take.
func (c *Consumer[R]) Ready() <-chan struct{} { return c.notify }

// Pending is the number of coalesced changes waiting (queue depth).
func (c *Consumer[R]) Pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.pending)
}

// Resync makes the next batch a full snapshot (after a gap on the client).
func (c *Consumer[R]) Resync() {
	c.mu.Lock()
	c.snapshot, c.pending = true, map[string]op[R]{}
	c.mark(time.Now())
	c.mu.Unlock()
	c.signal()
}

// Batch is what one send carries.
type Batch[R Row] struct {
	Snapshot   bool
	Rows       []R // snapshot rows
	Upserts    []R
	Deletes    []string
	State      State
	Detail     string
	StateDirty bool
	Events     int       // source events folded into this batch
	Oldest     time.Time // arrival of the oldest change in it
}

func (b *Batch[R]) Empty() bool {
	return !b.Snapshot && !b.StateDirty && len(b.Upserts) == 0 && len(b.Deletes) == 0
}

// Take removes everything pending and returns it as one batch.
func (c *Consumer[R]) Take() Batch[R] {
	c.mu.Lock()
	b := Batch[R]{Snapshot: c.snapshot, State: c.state, Detail: c.detail, StateDirty: c.stateDirty || c.snapshot, Events: c.events, Oldest: c.oldest}
	pending := c.pending
	c.pending, c.snapshot, c.stateDirty, c.events, c.oldest = map[string]op[R]{}, false, false, 0, time.Time{}
	c.mu.Unlock()
	if b.Snapshot {
		t := c.topic
		t.mu.Lock()
		b.Rows = make([]R, 0, len(t.rows))
		for _, r := range t.rows {
			b.Rows = append(b.Rows, r)
		}
		b.State, b.Detail = t.state, t.err
		t.mu.Unlock()
		return b
	}
	for id, o := range pending {
		if o.del {
			b.Deletes = append(b.Deletes, id)
		} else {
			b.Upserts = append(b.Upserts, o.row)
		}
	}
	return b
}

// Return puts back a batch that could not be sent. Changes that arrived in
// the meantime are newer and win.
func (c *Consumer[R]) Return(b Batch[R]) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if b.Snapshot {
		c.snapshot, c.pending = true, map[string]op[R]{}
	} else if !c.snapshot {
		for _, r := range b.Upserts {
			if _, newer := c.pending[r.RowID()]; !newer {
				c.pending[r.RowID()] = op[R]{row: r}
			}
		}
		for _, id := range b.Deletes {
			if _, newer := c.pending[id]; !newer {
				c.pending[id] = op[R]{del: true}
			}
		}
	}
	c.stateDirty = c.stateDirty || b.StateDirty
	c.events += b.Events
	if c.oldest.IsZero() || (!b.Oldest.IsZero() && b.Oldest.Before(c.oldest)) {
		c.oldest = b.Oldest
	}
}

// Close detaches the consumer; the source stops when no consumer is left.
func (c *Consumer[R]) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.mu.Unlock()
	c.topic.hub.release(c.topic, c)
}

// Pending sums the coalesced changes waiting in every consumer (queue depth).
func (h *Hub[R]) Pending() int {
	h.mu.Lock()
	ts := make([]*topic[R], 0, len(h.topics))
	for _, t := range h.topics {
		ts = append(ts, t)
	}
	h.mu.Unlock()
	n := 0
	for _, t := range ts {
		t.mu.Lock()
		cs := make([]*Consumer[R], 0, len(t.consumers))
		for c := range t.consumers {
			cs = append(cs, c)
		}
		t.mu.Unlock()
		for _, c := range cs {
			n += c.Pending()
		}
	}
	return n
}

// Rows of one topic (a copy), or nil when nobody subscribes to the key.
func (h *Hub[R]) TopicRows(key Key) []R {
	h.mu.Lock()
	t := h.topics[key]
	h.mu.Unlock()
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]R, 0, len(t.rows))
	for _, r := range t.rows {
		out = append(out, r)
	}
	return out
}
