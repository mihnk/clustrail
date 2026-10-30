package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/mihnk/clustrail/internal/diagnostics"
	"github.com/mihnk/clustrail/internal/kube"
	"github.com/mihnk/clustrail/internal/mock"
	"github.com/mihnk/clustrail/internal/streaming"
)

// PodsStream is the Wails stream the Pods explorer subscribes on.
const PodsStream = "clustrail.pods"

// startPods sets up the pod pipeline: real clusters through their pod
// informer, synthetic clusters (CLUSTRAIL_SYNTHETIC) through the mock provider.
func (w *Workspace) startPods(ctx context.Context) {
	w.m.StreamPods = true
	synthetic := map[string]mock.Config{}
	if spec := os.Getenv("CLUSTRAIL_SYNTHETIC"); spec != "" {
		cfgs, err := mock.ParseSpec(spec)
		if err != nil {
			slog.Error("synthetic clusters", "error", err)
		}
		var infos []kube.SyntheticCluster
		for _, c := range cfgs {
			synthetic[c.Cluster] = c
			infos = append(infos, kube.SyntheticCluster{ID: c.Cluster, Pods: c.Pods, Rate: c.Rate})
		}
		w.m.AddSynthetic(infos)
		slog.Info("synthetic clusters", "spec", spec, "clusters", len(cfgs))
	}
	w.pods = streaming.NewHub[kube.PodRow](ctx, func(k streaming.Key) (streaming.Source[kube.PodRow], error) {
		if k.Kind != "Pod" {
			return nil, errors.New("only Pods are streamed")
		}
		if cfg, ok := synthetic[k.Cluster]; ok {
			return mock.Source(cfg), nil
		}
		return w.m.PodSource(k)
	})
}

// ServePods handles one window's connection to the pods stream.
func (w *Workspace) ServePods(c *application.StreamConn) {
	defer c.Close()
	slog.Info("pods stream connected")
	defer slog.Info("pods stream closed")
	streaming.Serve(w.pods, wailsConn{c})
}

type wailsConn struct{ c *application.StreamConn }

func (w wailsConn) TrySend(b []byte) error {
	if err := w.c.TrySend(b); errors.Is(err, application.ErrStreamFull) {
		return streaming.ErrFull
	} else {
		return err
	}
}
func (w wailsConn) Receive() ([]byte, error) { return w.c.Receive() }
func (w wailsConn) Context() context.Context { return w.c.Context() }

// Diagnostics is the development diagnostics view's data.
type Diagnostics struct {
	Process   diagnostics.Process `json:"process"`
	Watches   int                 `json:"watches"` // active subscription scopes
	Consumers int64               `json:"consumers"`
	Rows      int                 `json:"rows"` // cached projection rows
	Pending   int                 `json:"pending"`
	Events    int64               `json:"events"`
	Frames    int64               `json:"frames"`
	Bytes     int64               `json:"bytes"`
	Snapshots int64               `json:"snapshots"`
	SendFull  int64               `json:"sendFull"`
	Resyncs   int64               `json:"resyncs"`
	MaxBatch  int64               `json:"maxBatch"`
	Queue     streaming.Summary   `json:"queue"`
	Encode    streaming.Summary   `json:"encode"`
	Round     streaming.Summary   `json:"round"`
	UI        streaming.Summary   `json:"ui"`
	Visible   streaming.Summary   `json:"visible"`
	Size      streaming.Summary   `json:"size"`
	At        int64               `json:"at"`
}

func (w *Workspace) Diagnostics() Diagnostics {
	s := w.pods.Stats
	return Diagnostics{
		Process: diagnostics.Sample(), Watches: len(w.pods.Topics()), Consumers: s.Consumers.Load(), Rows: w.pods.Rows(), Pending: w.pods.Pending(),
		Events: s.Events.Load(), Frames: s.Frames.Load(), Bytes: s.Bytes.Load(), Snapshots: s.Snapshots.Load(), SendFull: s.SendFull.Load(),
		Resyncs: s.Resyncs.Load(), MaxBatch: s.MaxPending.Load(),
		Queue: s.Queue.Summary(), Encode: s.Encode.Summary(), Round: s.Round.Summary(), UI: s.UI.Summary(), Visible: s.Visible.Summary(), Size: s.Size.Summary(),
		At: time.Now().UnixMilli(),
	}
}

// ResetDiagnostics clears latency samples (between benchmark phases).
func (w *Workspace) ResetDiagnostics() {
	s := w.pods.Stats
	for _, x := range []*streaming.Samples{&s.Queue, &s.Encode, &s.Round, &s.UI, &s.Visible, &s.Size} {
		x.Reset()
	}
	s.MaxPending.Store(0)
}

// BenchConfig tells the UI which benchmark to run (CLUSTRAIL_BENCH), if any.
func (w *Workspace) BenchConfig() map[string]string {
	if os.Getenv("CLUSTRAIL_BENCH") == "" {
		return nil
	}
	return map[string]string{"scenario": os.Getenv("CLUSTRAIL_BENCH"), "synthetic": os.Getenv("CLUSTRAIL_SYNTHETIC"), "seconds": os.Getenv("CLUSTRAIL_BENCH_SECONDS")}
}

// ReportBench receives the UI's benchmark result, writes it to
// CLUSTRAIL_BENCH_OUT and quits.
func (w *Workspace) ReportBench(result string) error {
	out := os.Getenv("CLUSTRAIL_BENCH_OUT")
	if out == "" {
		out = "clustrail-bench.json"
	}
	err := os.WriteFile(out, []byte(result), 0o644)
	slog.Info("benchmark finished", "out", out, "error", err)
	go func() {
		time.Sleep(200 * time.Millisecond)
		application.Get().Quit()
	}()
	return err
}

// SetSyntheticPaused pauses changes on synthetic clusters (benchmarks).
func (w *Workspace) SetSyntheticPaused(on bool) { mock.SetPaused(on) }

// PodChecksum summarizes the backend's rows of a cluster so the UI can verify
// it holds exactly the same state: count, and a sum of per-row FNV-1a hashes
// of "id|status|restarts|ready/total" (order-independent).
func (w *Workspace) PodChecksum(cluster string) map[string]uint32 {
	rows := w.pods.TopicRows(streaming.Key{Cluster: cluster, Kind: "Pod"})
	var sum uint32
	for _, r := range rows {
		sum += fnv32(fmt.Sprintf("%s|%s|%d|%d/%d", r.ID, r.Status, r.Restarts, r.ReadyContainers, r.TotalContainers))
	}
	return map[string]uint32{"count": uint32(len(rows)), "sum": sum}
}

func fnv32(s string) uint32 {
	h := uint32(2166136261)
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= 16777619
	}
	return h
}
