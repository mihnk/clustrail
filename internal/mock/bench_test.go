package mock

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/mihnk/clustrail/internal/kube"
	"github.com/mihnk/clustrail/internal/streaming"
)

// The Go half of the pipeline, without the transport: synthetic changes into
// a hub topic, coalesced per consumer, taken and JSON-encoded as the sender does.

type hubSink struct{ s streaming.Sink[kube.PodRow] }

func benchHub(b *testing.B, pods int) (*Generator, streaming.Sink[kube.PodRow], *streaming.Consumer[kube.PodRow]) {
	g := New(Config{Cluster: "bench", Pods: pods, Seed: 1})
	got := make(chan streaming.Sink[kube.PodRow], 1)
	h := streaming.NewHub[kube.PodRow](context.Background(), func(streaming.Key) (streaming.Source[kube.PodRow], error) {
		return func(ctx context.Context, s streaming.Sink[kube.PodRow]) { got <- s; <-ctx.Done() }, nil
	})
	c, _ := h.Subscribe(streaming.Key{Cluster: "bench", Kind: "Pod"})
	s := <-got
	s.Replace(g.Rows())
	c.Take()
	b.Cleanup(c.Close)
	return g, s, c
}

// BenchmarkEventPath: one change through the hub, folded, flushed every 50 changes (≈ 1,000/s at a 50 ms window).
func BenchmarkEventPath10k(b *testing.B) {
	g, s, c := benchHub(b, 10000)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if row, del := g.Step(); del != "" {
			s.Delete(del)
		} else {
			s.Upsert(row)
		}
		if i%50 == 49 {
			batch := c.Take()
			buf, _ := json.Marshal(streaming.Frame[kube.PodRow]{T: "delta", Upserts: batch.Upserts, Deletes: batch.Deletes})
			_ = buf
		}
	}
}

func benchmarkSnapshot(b *testing.B, pods int) {
	g := New(Config{Cluster: "bench", Pods: pods, Seed: 1})
	rows := g.Rows()
	b.ReportAllocs()
	b.ResetTimer()
	var size int
	for i := 0; i < b.N; i++ {
		size = 0
		for part := 0; part*streaming.SnapshotChunk < len(rows); part++ {
			end := min(len(rows), (part+1)*streaming.SnapshotChunk)
			buf, _ := json.Marshal(streaming.Frame[kube.PodRow]{T: "snap", Rows: rows[part*streaming.SnapshotChunk : end]})
			size += len(buf)
		}
	}
	b.ReportMetric(float64(size)/float64(pods), "bytes/pod")
	b.ReportMetric(float64(size)/(1<<20), "MB/snapshot")
}

func BenchmarkSnapshot10k(b *testing.B) { benchmarkSnapshot(b, 10000) }
func BenchmarkSnapshot50k(b *testing.B) { benchmarkSnapshot(b, 50000) }

func BenchmarkGenerate50k(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		New(Config{Cluster: "bench", Pods: 50000, Seed: uint64(i + 1)})
	}
}
