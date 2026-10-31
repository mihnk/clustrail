// Package mock is the synthetic Kubernetes provider used for benchmarks and
// the mock mode: deterministic Pod datasets and change streams that go
// through the same hub, projection and UI pipeline as a real cluster.
package mock

import (
	"context"
	"fmt"
	"math/rand/v2"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/mihnk/clustrail/internal/kube"
	"github.com/mihnk/clustrail/internal/streaming"
)

// Config describes one synthetic cluster.
type Config struct {
	Cluster    string
	Pods       int
	Namespaces int
	Nodes      int
	// Rate is changes per second (0: static).
	Rate int
	Seed uint64
	// Every DisconnectEvery the cluster drops for DisconnectFor, then re-lists.
	DisconnectEvery time.Duration
	DisconnectFor   time.Duration
	// ListDelay simulates a slow API server before the first list.
	ListDelay time.Duration
}

func (c Config) withDefaults() Config {
	if c.Namespaces <= 0 {
		c.Namespaces = max(1, min(200, c.Pods/250))
	}
	if c.Nodes <= 0 {
		c.Nodes = max(3, c.Pods/40)
	}
	if c.Seed == 0 {
		c.Seed = 1
	}
	return c
}

var apps = []string{"api", "web", "worker", "checkout", "payments", "ledger", "search", "auth", "billing", "gateway", "cache", "queue", "reports", "notifier", "ingest"}

// Generator holds a synthetic cluster's pods and mutates them deterministically.
type Generator struct {
	cfg   Config
	rng   *rand.Rand
	pods  []kube.PodRow
	index map[string]int // id → position in pods
	next  int            // counter for new pod names
}

// New creates a generator with cfg.Pods pods; the same Config always yields the same data.
func New(cfg Config) *Generator {
	cfg = cfg.withDefaults()
	g := &Generator{cfg: cfg, rng: rand.New(rand.NewPCG(cfg.Seed, uint64(len(cfg.Cluster)))), index: make(map[string]int, cfg.Pods)}
	g.pods = make([]kube.PodRow, 0, cfg.Pods)
	for i := 0; i < cfg.Pods; i++ {
		g.add(g.pod())
	}
	return g
}

func (g *Generator) add(p kube.PodRow) {
	g.index[p.ID] = len(g.pods)
	g.pods = append(g.pods, p)
}

func (g *Generator) remove(i int) kube.PodRow {
	p := g.pods[i]
	last := len(g.pods) - 1
	g.pods[i] = g.pods[last]
	g.index[g.pods[i].ID] = i
	g.pods = g.pods[:last]
	delete(g.index, p.ID)
	return p
}

func (g *Generator) pod() kube.PodRow {
	g.next++
	app := apps[g.rng.IntN(len(apps))]
	ns := fmt.Sprintf("team-%03d", g.rng.IntN(g.cfg.Namespaces))
	rs := strconv.FormatUint(g.rng.Uint64()%0xfffffffff, 36)
	name := fmt.Sprintf("%s-%s-%05d", app, rs[:min(9, len(rs))], g.next)
	total := 1 + g.rng.IntN(3)
	cpu, mem := 5+g.rng.IntN(900), 32+g.rng.IntN(2000)
	p := kube.PodRow{
		ID: g.cfg.Cluster + "/" + ns + "/" + name, Name: name, Namespace: ns, Cluster: g.cfg.Cluster, Env: kube.EnvDev,
		Node:            fmt.Sprintf("node-%04d", g.rng.IntN(g.cfg.Nodes)),
		ReadyContainers: total, TotalContainers: total,
		CPUMilli: &cpu, MemoryMiB: &mem,
		AgeSeconds: int64(60 + g.rng.IntN(30*86400)),
		Owner:      &kube.OwnerRef{Kind: "ReplicaSet", Name: app + "-" + rs[:min(9, len(rs))]},
		Labels:     map[string]string{"app": app},
	}
	g.setHealth(&p, g.rng.IntN(100))
	return p
}

// setHealth assigns a status from a 0-99 roll: mostly Running, some trouble.
func (g *Generator) setHealth(p *kube.PodRow, roll int) {
	switch {
	case roll < 90:
		p.Health, p.Status, p.Reason, p.ReadyContainers = kube.Healthy, "Running", "", p.TotalContainers
	case roll < 94:
		p.Health, p.Status, p.Reason, p.ReadyContainers = kube.Failed, "CrashLoop", "CrashLoopBackOff", p.TotalContainers-1
	case roll < 97:
		p.Health, p.Status, p.Reason, p.ReadyContainers = kube.Progressing, "Creating", "ContainerCreating", 0
	case roll < 99:
		p.Health, p.Status, p.Reason, p.ReadyContainers = kube.Warning, "Pending", "Unschedulable", 0
	default:
		p.Health, p.Status, p.Reason, p.ReadyContainers = kube.Completed, "Completed", "", 0
	}
}

// Rows returns a copy of the current pods.
func (g *Generator) Rows() []kube.PodRow { return append([]kube.PodRow(nil), g.pods...) }

// Len is the current pod count.
func (g *Generator) Len() int { return len(g.pods) }

// Step applies one random change and reports it: the changed row, or the id of a deleted one.
func (g *Generator) Step() (row kube.PodRow, deleted string) {
	roll := g.rng.IntN(100)
	if len(g.pods) == 0 || (roll < 8 && len(g.pods) < g.cfg.Pods*11/10) {
		p := g.pod()
		p.Health, p.Status, p.Reason, p.ReadyContainers, p.AgeSeconds = kube.Progressing, "Creating", "ContainerCreating", 0, 0
		g.add(p)
		return p, ""
	}
	i := g.rng.IntN(len(g.pods))
	if roll < 16 && len(g.pods) > g.cfg.Pods*9/10 {
		return kube.PodRow{}, g.remove(i).ID
	}
	p := g.pods[i]
	switch {
	case roll < 30: // container restart
		p.Restarts++
		g.setHealth(&p, 90+g.rng.IntN(4))
	case roll < 45: // health change
		g.setHealth(&p, g.rng.IntN(100))
	default: // usage drift (metrics refresh)
		cpu, mem := max(1, *p.CPUMilli+g.rng.IntN(41)-20), max(16, *p.MemoryMiB+g.rng.IntN(33)-16)
		p.CPUMilli, p.MemoryMiB = &cpu, &mem
	}
	g.pods[i] = p
	return p, ""
}

// paused stops every synthetic source's changes (benchmarks check consistency at rest).
var paused atomic.Bool

// SetPaused pauses or resumes changes on all synthetic clusters.
func SetPaused(on bool) { paused.Store(on) }

// Source streams the generator through a hub: a list, then cfg.Rate changes
// per second, with simulated disconnections when configured.
func Source(cfg Config) streaming.Source[kube.PodRow] {
	return func(ctx context.Context, sink streaming.Sink[kube.PodRow]) {
		g := New(cfg)
		sink.SetState(streaming.Connecting, "")
		if !sleep(ctx, cfg.ListDelay) {
			return
		}
		sink.Replace(g.Rows())
		sink.SetState(streaming.Live, "")
		if cfg.Rate == 0 && cfg.DisconnectEvery == 0 {
			<-ctx.Done() // nothing changes: no ticker, so idle benchmarks measure the app alone
			return
		}
		tick := 10 * time.Millisecond
		t := time.NewTicker(tick)
		defer t.Stop()
		var debt float64
		lastDrop := time.Now()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			if cfg.DisconnectEvery > 0 && time.Since(lastDrop) > cfg.DisconnectEvery {
				sink.SetState(streaming.Disconnected, "synthetic connection drop")
				if !sleep(ctx, cfg.DisconnectFor) {
					return
				}
				// Changes made while disconnected arrive with the re-list, as with a real watch.
				for range int(float64(cfg.Rate) * cfg.DisconnectFor.Seconds()) {
					g.Step()
				}
				sink.Replace(g.Rows())
				sink.SetState(streaming.Live, "")
				lastDrop = time.Now()
				continue
			}
			if paused.Load() {
				continue
			}
			debt += float64(cfg.Rate) * tick.Seconds()
			for ; debt >= 1; debt-- {
				if row, del := g.Step(); del != "" {
					sink.Delete(del)
				} else {
					sink.Upsert(row)
				}
			}
		}
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

// ParseSpec reads CLUSTRAIL_SYNTHETIC, e.g. "clusters=20,pods=10000,rate=1000,slow=2,drop=1".
// pods and rate are per cluster (vary=1 spreads them ½×–2× across clusters);
// slow makes that many clusters list after 5 s; drop makes that many clusters
// disconnect every 20 s for 3 s.
func ParseSpec(spec string) ([]Config, error) {
	vals := map[string]int{"clusters": 1, "pods": 10000, "rate": 0, "slow": 0, "drop": 0, "seed": 1, "vary": 0}
	for _, part := range strings.Split(spec, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok || k == "" {
			continue
		}
		n, err := strconv.Atoi(v)
		if _, known := vals[k]; !known || err != nil || n < 0 {
			return nil, fmt.Errorf("CLUSTRAIL_SYNTHETIC: bad %q", part)
		}
		vals[k] = n
	}
	out := make([]Config, vals["clusters"])
	for i := range out {
		out[i] = Config{Cluster: fmt.Sprintf("synthetic-%02d", i+1), Pods: vals["pods"], Rate: vals["rate"], Seed: uint64(vals["seed"] + i)}
		if vals["vary"] > 0 {
			// Uneven clusters: ½×, 1×, 1½× and 2× the given pods and rate, in turn.
			f := float64(i%4+1) / 2
			out[i].Pods, out[i].Rate = int(float64(out[i].Pods)*f), int(float64(out[i].Rate)*f)
		}
		if i < vals["slow"] {
			out[i].ListDelay = 5 * time.Second
		}
		if i >= len(out)-vals["drop"] {
			out[i].DisconnectEvery, out[i].DisconnectFor = 20*time.Second, 3*time.Second
		}
	}
	return out, nil
}
