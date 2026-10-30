package kube

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/labels"

	"github.com/mihnk/clustrail/internal/streaming"
)

// Pods reach the streaming hub straight from the connection's pod informer:
// one watch per cluster no matter how many windows or scopes subscribe, and
// no 250 ms flush in between.

type podSubscribers struct {
	mu   sync.Mutex
	subs map[*podSub]struct{}
}

type podSub struct {
	ns   string
	sink streaming.Sink[PodRow]
}

func (c *clusterConn) addPodSub(s *podSub) func() {
	c.podSubs.mu.Lock()
	if c.podSubs.subs == nil {
		c.podSubs.subs = map[*podSub]struct{}{}
	}
	c.podSubs.subs[s] = struct{}{}
	c.podSubs.mu.Unlock()
	return func() {
		c.podSubs.mu.Lock()
		delete(c.podSubs.subs, s)
		c.podSubs.mu.Unlock()
	}
}

// publishPod sends a pod's current row (or its deletion) to subscribed scopes.
func (c *clusterConn) publishPod(ns, name string) {
	c.podSubs.mu.Lock()
	if len(c.podSubs.subs) == 0 {
		c.podSubs.mu.Unlock()
		return
	}
	subs := make([]*podSub, 0, len(c.podSubs.subs))
	for s := range c.podSubs.subs {
		if s.ns == "" || s.ns == ns {
			subs = append(subs, s)
		}
	}
	c.podSubs.mu.Unlock()
	if len(subs) == 0 || c.pods == nil {
		return
	}
	id := c.id + "/" + ns + "/" + name
	p, err := c.pods.Pods(ns).Get(name)
	if err != nil {
		for _, s := range subs {
			s.sink.Delete(id)
		}
		return
	}
	row := c.podRow(p, c.env(), time.Now())
	for _, s := range subs {
		s.sink.Upsert(row)
	}
}

// ErrSynthetic is returned for operations a synthetic (benchmark) cluster does not support.
var ErrSynthetic = errors.New("synthetic cluster: no Kubernetes API behind it")

// PodSource is the streaming source of a real cluster's pods in one scope.
// It follows the cluster across disconnects: while it is not connected the
// scope is reported disconnected (rows kept, marked not live), and after a
// reconnect the rows are replaced by a fresh list.
func (m *Manager) PodSource(key streaming.Key) (streaming.Source[PodRow], error) {
	m.mu.Lock()
	_, known := m.state[key.Cluster]
	m.mu.Unlock()
	if !known {
		return nil, fmt.Errorf("unknown cluster %q", key.Cluster)
	}
	return func(ctx context.Context, sink streaming.Sink[PodRow]) {
		sink.SetState(streaming.Connecting, "")
		for ctx.Err() == nil {
			c, err := m.conn(key.Cluster)
			if err == nil && !c.started.Load() {
				// Connecting: its informers are not set up yet.
				if !sleepFor(ctx, 100*time.Millisecond) {
					return
				}
				continue
			}
			if err != nil || c.pods == nil {
				detail := "not connected"
				if c != nil && c.pods == nil {
					detail = "pods cannot be listed with this identity (RBAC)"
				}
				sink.SetState(streaming.Disconnected, detail)
				if !sleepFor(ctx, time.Second) {
					return
				}
				continue
			}
			m.followConn(ctx, c, key, sink)
		}
	}, nil
}

// followConn streams one connection until it ends or ctx does.
func (m *Manager) followConn(ctx context.Context, c *clusterConn, key streaming.Key, sink streaming.Sink[PodRow]) {
	remove := c.addPodSub(&podSub{ns: key.Namespace, sink: sink})
	defer remove()
	for !c.synced() {
		if !sleepFor(ctx, 50*time.Millisecond) || c.ctx.Err() != nil {
			return
		}
	}
	// Subscribed before listing: a change in between is sent twice, never lost.
	var list []PodRow
	now, env := time.Now(), c.env()
	pods, _ := c.pods.List(labels.Everything())
	for _, p := range pods {
		if key.Namespace == "" || p.Namespace == key.Namespace {
			list = append(list, c.podRow(p, env, now))
		}
	}
	sink.Replace(list)
	last := streaming.State("")
	for {
		state := streaming.Live
		m.mu.Lock()
		if st := m.state[key.Cluster]; st != nil && st.Connection == Reconnecting {
			state = streaming.Stale
		}
		m.mu.Unlock()
		if state != last {
			detail := ""
			if state == streaming.Stale {
				detail = "watch lost; showing the last known rows while reconnecting"
			}
			sink.SetState(state, detail)
			last = state
		}
		select {
		case <-ctx.Done():
			return
		case <-c.ctx.Done():
			sink.SetState(streaming.Disconnected, "disconnected")
			return
		case <-time.After(time.Second):
		}
	}
}

func sleepFor(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

// SyntheticCluster describes a benchmark cluster served by the mock provider.
type SyntheticCluster struct {
	ID   string
	Pods int
	Rate int
}

// AddSynthetic lists synthetic clusters as connected development clusters.
// Their pods stream from the mock provider; every other call on them returns
// ErrSynthetic. They are never written to the settings file.
func (m *Manager) AddSynthetic(clusters []SyntheticCluster) {
	m.mu.Lock()
	if m.synthetic == nil {
		m.synthetic = map[string]bool{}
	}
	for _, sc := range clusters {
		m.synthetic[sc.ID] = true
		summary := fmt.Sprintf("synthetic · %d pods · %d changes/s", sc.Pods, sc.Rate)
		m.state[sc.ID] = &Cluster{ID: sc.ID, Name: sc.ID, Context: sc.ID, Env: EnvDev, Connection: Connected, Summary: &summary, Source: "CLUSTRAIL_SYNTHETIC", LatencyMs: ptr(0), Metrics: ptr("synthetic")}
	}
	m.mu.Unlock()
	m.emitClusters()
}
