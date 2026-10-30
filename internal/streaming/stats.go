package streaming

import (
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// Stats are the pipeline counters the diagnostics view reads.
type Stats struct {
	Events     atomic.Int64 // source changes received
	Frames     atomic.Int64 // frames sent
	Bytes      atomic.Int64 // bytes sent
	Snapshots  atomic.Int64
	SendFull   atomic.Int64 // sends refused because the window's queue was full
	Resyncs    atomic.Int64 // snapshots a client asked for after a sequence gap
	Topics     atomic.Int64
	Consumers  atomic.Int64
	MaxPending atomic.Int64 // largest coalesced queue seen at a flush

	Queue   Samples // event arrival → frame sent (backend queueing), ms
	Encode  Samples // batch build + JSON encode, ms
	Round   Samples // frame sent → ack received (transport + UI apply/render + ack), ms
	UI      Samples // UI receive → rendered, as the UI reports it, ms
	Visible Samples // estimated event → visible: queue + (round − ui)/2 + ui, ms
	Size    Samples // changes per delta frame
}

// Samples keeps the last 2048 values for percentiles.
type Samples struct {
	mu   sync.Mutex
	buf  [2048]float64
	n    int
	next int
}

func (s *Samples) Add(v float64) {
	s.mu.Lock()
	s.buf[s.next] = v
	s.next = (s.next + 1) % len(s.buf)
	if s.n < len(s.buf) {
		s.n++
	}
	s.mu.Unlock()
}

// Summary is count and percentiles of the kept samples.
type Summary struct {
	N   int     `json:"n"`
	P50 float64 `json:"p50"`
	P95 float64 `json:"p95"`
	P99 float64 `json:"p99"`
	Max float64 `json:"max"`
}

func (s *Samples) Summary() Summary {
	s.mu.Lock()
	v := append([]float64(nil), s.buf[:s.n]...)
	s.mu.Unlock()
	if len(v) == 0 {
		return Summary{}
	}
	sort.Float64s(v)
	at := func(p float64) float64 { return v[min(len(v)-1, int(p*float64(len(v))))] }
	return Summary{N: len(v), P50: at(.50), P95: at(.95), P99: at(.99), Max: v[len(v)-1]}
}

func (s *Samples) Reset() {
	s.mu.Lock()
	s.n, s.next = 0, 0
	s.mu.Unlock()
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }
