package kube

import (
	"context"
	"fmt"
	"log/slog"
	"runtime"
	"sort"
	"sync/atomic"
	"time"

	"k8s.io/apimachinery/pkg/labels"
)

// EventNotice tells the UI about something the backend did on its own, such
// as disconnecting a cluster to stay within the cache budget.
const EventNotice = "clustrail:notice"

// Notice is shown as a toast.
type Notice struct {
	Kind   string `json:"kind"` // info, warning
	Title  string `json:"title"`
	Detail string `json:"detail,omitempty"`
}

// busy reports whether a cluster has a log stream, shell or port forward open:
// pausing it would cut them.
func (m *Manager) busy(cluster string) bool {
	m.streams.mu.Lock()
	for _, l := range m.streams.logs {
		if l.cluster == cluster {
			m.streams.mu.Unlock()
			return true
		}
	}
	for _, e := range m.streams.exec {
		if e.cluster == cluster {
			m.streams.mu.Unlock()
			return true
		}
	}
	m.streams.mu.Unlock()
	for _, f := range m.PortForwards() {
		if f.Cluster == cluster {
			return true
		}
	}
	return false
}

// PauseWatches disconnects connected clusters while the app is in the
// background (Settings › Pause watches in background tabs). Clusters with an
// open log stream, shell or port forward stay connected. It returns the
// paused clusters; ResumeWatches reconnects them with a full re-list.
func (m *Manager) PauseWatches() []string {
	m.mu.Lock()
	var ids []string
	for id := range m.conns {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	sort.Strings(ids)
	var paused []string
	for _, id := range ids {
		if m.busy(id) {
			continue
		}
		m.Disconnect(id)
		m.setState(id, func(c *Cluster) { c.Paused = true })
		paused = append(paused, id)
	}
	if len(paused) > 0 {
		slog.Info("watches paused in background", "clusters", paused)
	}
	return paused
}

// ResumeWatches reconnects every cluster PauseWatches disconnected.
func (m *Manager) ResumeWatches() {
	m.mu.Lock()
	var ids []string
	for id, st := range m.state {
		if st.Paused {
			st.Paused = false
			ids = append(ids, id)
		}
	}
	m.mu.Unlock()
	if len(ids) > 0 {
		slog.Info("watches resumed", "clusters", ids)
	}
	for _, id := range ids {
		m.Connect(id)
	}
}

// cacheBudgetMB bounds the memory Clustrail's caches may use (Settings ›
// Resource cache budget); 0 means no limit.
var cacheBudgetMB atomic.Int64

func SetCacheBudget(mb int) { cacheBudgetMB.Store(int64(mb)) }

// MemoryStats is what Settings shows next to the budget.
type MemoryStats struct {
	HeapMB   int            `json:"heapMB"`
	BudgetMB int            `json:"budgetMB"`
	Objects  map[string]int `json:"objects"` // cached objects per connected cluster
}

func (m *Manager) MemoryStats() MemoryStats {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	out := MemoryStats{HeapMB: int(ms.HeapInuse >> 20), BudgetMB: int(cacheBudgetMB.Load()), Objects: map[string]int{}}
	m.mu.Lock()
	conns := make(map[string]*clusterConn, len(m.conns))
	for id, c := range m.conns {
		conns[id] = c
	}
	m.mu.Unlock()
	for id, c := range conns {
		out.Objects[id] = c.cachedObjects()
	}
	return out
}

func (c *clusterConn) cachedObjects() int {
	n := 0
	for _, idx := range []interface{ ListKeys() []string }{c.podsByNode, c.rsByOwner} {
		if idx != nil {
			n += len(idx.ListKeys())
		}
	}
	if c.deploys != nil {
		if l, err := c.deploys.List(labels.Everything()); err == nil {
			n += len(l)
		}
	}
	if c.nodes != nil {
		if l, err := c.nodes.List(labels.Everything()); err == nil {
			n += len(l)
		}
	}
	return n
}

// budgetLoop keeps the Go heap within the cache budget: over it, connected
// clusters that are not selected in the UI are disconnected, the largest
// first. Selected clusters are never disconnected; the UI is told either way.
func (m *Manager) budgetLoop(ctx context.Context) {
	warned := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second):
		}
		budget := cacheBudgetMB.Load()
		if budget <= 0 {
			continue
		}
		stats := m.MemoryStats()
		if int64(stats.HeapMB) <= budget {
			warned = false
			continue
		}
		selected := map[string]bool{}
		for _, id := range m.store.Selected() {
			selected[id] = true
		}
		var candidates []string
		for id := range stats.Objects {
			if !selected[id] && !m.busy(id) {
				candidates = append(candidates, id)
			}
		}
		sort.Slice(candidates, func(i, j int) bool { return stats.Objects[candidates[i]] > stats.Objects[candidates[j]] })
		if len(candidates) == 0 {
			if !warned {
				warned = true
				slog.Warn("over cache budget with selected clusters only", "heapMB", stats.HeapMB, "budgetMB", budget)
				m.emit.Emit(EventNotice, Notice{Kind: "warning", Title: "Over the cache budget",
					Detail: fmt.Sprintf("%d MB in use, budget %d MB. Only selected clusters are connected, so none was disconnected.", stats.HeapMB, budget)})
			}
			continue
		}
		id := candidates[0]
		m.Disconnect(id)
		runtime.GC()
		slog.Info("disconnected to stay within the cache budget", "cluster", id, "heapMB", stats.HeapMB, "budgetMB", budget)
		m.emit.Emit(EventNotice, Notice{Kind: "info", Title: "Disconnected " + id,
			Detail: fmt.Sprintf("%d MB in use, budget %d MB. It was connected but not selected; connect it again any time.", stats.HeapMB, budget)})
	}
}
