package kube

import (
	"sync"
	"time"
)

// sampleStore keeps the last n metrics-server samples per container. History
// starts when Clustrail connected; metrics-server itself keeps none.
type sampleStore struct {
	mu   sync.Mutex
	n    int
	data map[string]*ring
}

type ring struct {
	ts   []int64
	vals []float32
	next int
	full bool
}

func newSampleStore(n int) *sampleStore { return &sampleStore{n: n, data: map[string]*ring{}} }

func (s *sampleStore) add(key string, at time.Time, v float32) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.data[key]
	if r == nil {
		r = &ring{ts: make([]int64, s.n), vals: make([]float32, s.n)}
		s.data[key] = r
	}
	r.ts[r.next], r.vals[r.next] = at.Unix(), v
	r.next = (r.next + 1) % s.n
	if r.next == 0 {
		r.full = true
	}
}

// series returns the samples of a container in time order.
func (s *sampleStore) series(key string) (ts []int64, vals []float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.data[key]
	if r == nil {
		return nil, nil
	}
	start, count := 0, r.next
	if r.full {
		start, count = r.next, s.n
	}
	for i := 0; i < count; i++ {
		j := (start + i) % s.n
		ts = append(ts, r.ts[j])
		vals = append(vals, float64(r.vals[j]))
	}
	return ts, vals
}

// forget drops samples of containers whose pods are gone.
func (s *sampleStore) forget(keep func(key string) bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k := range s.data {
		if !keep(k) {
			delete(s.data, k)
		}
	}
}
