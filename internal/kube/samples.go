package kube

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

// Samples survive restarts: each connected cluster's store is written to the
// user cache directory and read back on the next connect, keeping only
// samples younger than sampleMaxAge.
const sampleMaxAge = 2 * time.Hour

// metricsCacheDir is a variable so tests write into a temp dir.
var metricsCacheDir = func() string {
	dir, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "clustrail", "metrics")
}

type savedSeries struct {
	TS   []int64   `json:"ts"`
	Vals []float32 `json:"v"`
}

func samplesPath(cluster string) string {
	dir := metricsCacheDir()
	if dir == "" {
		return ""
	}
	// Cluster IDs are slugs, but keep the file name safe regardless.
	return filepath.Join(dir, strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == ':' || r == os.PathSeparator {
			return '_'
		}
		return r
	}, cluster)+".json")
}

// save writes every series in time order; an empty store removes the file.
func (s *sampleStore) save(path string) error {
	if path == "" {
		return nil
	}
	s.mu.Lock()
	keys := make([]string, 0, len(s.data))
	for k := range s.data {
		keys = append(keys, k)
	}
	s.mu.Unlock()
	out := make(map[string]savedSeries, len(keys))
	for _, k := range keys {
		ts, vals := s.series(k)
		if len(ts) == 0 {
			continue
		}
		v32 := make([]float32, len(vals))
		for i, v := range vals {
			v32[i] = float32(v)
		}
		out[k] = savedSeries{TS: ts, Vals: v32}
	}
	if len(out) == 0 {
		_ = os.Remove(path)
		return nil
	}
	b, err := json.Marshal(out)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// load adds saved samples newer than now-maxAge. Call it before collecting so
// each series stays in time order.
func (s *sampleStore) load(path string, now time.Time, maxAge time.Duration) {
	if path == "" {
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var saved map[string]savedSeries
	if json.Unmarshal(b, &saved) != nil {
		return
	}
	cutoff := now.Add(-maxAge).Unix()
	for k, ser := range saved {
		for i, t := range ser.TS {
			if t >= cutoff && i < len(ser.Vals) {
				s.add(k, time.Unix(t, 0), ser.Vals[i])
			}
		}
	}
}
