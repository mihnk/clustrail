package mock

import (
	"context"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/mihnk/clustrail/internal/kube"
	"github.com/mihnk/clustrail/internal/streaming"
)

func TestGeneratorIsDeterministic(t *testing.T) {
	a, b := New(Config{Cluster: "s1", Pods: 2000, Seed: 7}), New(Config{Cluster: "s1", Pods: 2000, Seed: 7})
	for range 5000 {
		a.Step()
		b.Step()
	}
	if !reflect.DeepEqual(a.Rows(), b.Rows()) {
		t.Fatal("same config must give the same data")
	}
	ids := map[string]bool{}
	for _, p := range a.Rows() {
		if ids[p.ID] || p.ID != p.Cluster+"/"+p.Namespace+"/"+p.Name {
			t.Fatalf("bad or duplicate id %q", p.ID)
		}
		ids[p.ID] = true
	}
	if n := a.Len(); n < 1800 || n > 2200 {
		t.Fatalf("population drifted to %d", n)
	}
}

type sink struct {
	mu     sync.Mutex
	rows   map[string]kube.PodRow
	states []streaming.State
	events int
}

func (s *sink) Replace(rows []kube.PodRow) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rows = map[string]kube.PodRow{}
	for _, r := range rows {
		s.rows[r.ID] = r
	}
}
func (s *sink) Upsert(r kube.PodRow) { s.mu.Lock(); s.rows[r.ID] = r; s.events++; s.mu.Unlock() }
func (s *sink) Delete(id string)     { s.mu.Lock(); delete(s.rows, id); s.events++; s.mu.Unlock() }
func (s *sink) SetState(st streaming.State, _ string) {
	s.mu.Lock()
	s.states = append(s.states, st)
	s.mu.Unlock()
}

func TestSourceRateAndDisconnects(t *testing.T) {
	s := &sink{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		Source(Config{Cluster: "s1", Pods: 1000, Rate: 1000, DisconnectEvery: 300 * time.Millisecond, DisconnectFor: 100 * time.Millisecond})(ctx, s)
		close(done)
	}()
	time.Sleep(time.Second)
	cancel()
	<-done
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.events < 400 || s.events > 1100 {
		t.Fatalf("events in ~0.7s of streaming at 1000/s: %d", s.events)
	}
	drops := 0
	for _, st := range s.states {
		if st == streaming.Disconnected {
			drops++
		}
	}
	if drops < 2 || s.states[len(s.states)-1] == streaming.Connecting {
		t.Fatalf("states = %v", s.states)
	}
}

func TestParseSpec(t *testing.T) {
	cfgs, err := ParseSpec("clusters=20, pods=500, rate=100, slow=1, drop=2")
	if err != nil || len(cfgs) != 20 || cfgs[0].ListDelay == 0 || cfgs[1].ListDelay != 0 || cfgs[19].DisconnectEvery == 0 || cfgs[17].DisconnectEvery != 0 || cfgs[3].Cluster != "synthetic-04" {
		t.Fatalf("cfgs = %+v, %v", cfgs, err)
	}
	if _, err := ParseSpec("pods=abc"); err == nil {
		t.Fatal("bad value must fail")
	}
}
