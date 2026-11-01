//go:build envtest

package kube

// Soak (issue D3): many connect/disconnect cycles, list watches opened and
// closed, and pods coming and going, against a real API server. The test
// asserts that goroutines return to the start and that the Go heap after GC
// stays within budget; SOAK_OUT writes the samples as JSON.
//
//	KUBEBUILDER_ASSETS=/path/to/envtest/bin SOAK_CYCLES=200 \
//	  go test -tags envtest -run TestSoak -v -timeout 60m ./internal/kube

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"testing"
	"time"

	"go.uber.org/goleak"
)

type soakSample struct {
	Cycle      int     `json:"cycle"`
	HeapMB     float64 `json:"heapMB"`
	Goroutines int     `json:"goroutines"`
}

func heapAfterGC() float64 {
	runtime.GC()
	runtime.GC()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return float64(ms.HeapAlloc) / (1 << 20)
}

func TestSoak(t *testing.T) {
	bins := envtestBins(t)
	chaosTiming(t)
	cycles := envInt("SOAK_CYCLES", 30)
	env := startEnvCluster(t, bins)
	admin := adminClient(t, env.host)
	makePods(t, admin, "soak", "steady", 200)

	m := chaosManager(t, env.host)
	waitSameRows(t, m, admin, "soak")
	// Warm-up: one full cycle, so lazily started runtime goroutines exist before the baseline.
	m.Disconnect("envtest")
	m.Connect("envtest")
	waitConnection(t, m, 60*time.Second, Connected)
	m.Disconnect("envtest")
	time.Sleep(time.Second)
	base := goleak.IgnoreCurrent()
	baseHeap := heapAfterGC()

	var samples []soakSample
	for i := range cycles {
		m.Connect("envtest")
		waitConnection(t, m, 60*time.Second, Connected)
		id, err := m.StartListWatch("envtest", "ConfigMap", "")
		if err != nil {
			t.Fatal(err)
		}
		// Pods come and go with new names while connected.
		prefix := fmt.Sprintf("churn-%d", i)
		makePods(t, admin, "soak", prefix, 10)
		deletePods(t, admin, "soak", prefix, 10)
		waitSameRows(t, m, admin, "soak")
		m.StopListWatch(id)
		m.Disconnect("envtest")
		if i%5 == 0 || i == cycles-1 {
			time.Sleep(300 * time.Millisecond) // the closed connection's goroutines end
			samples = append(samples, soakSample{Cycle: i, HeapMB: heapAfterGC(), Goroutines: runtime.NumGoroutine()})
		}
	}
	// Nothing grows with the number of cycles: a goroutine or cache that
	// outlives its connection shows here before the end.
	first, last := samples[0], samples[len(samples)-1]
	if last.Goroutines > first.Goroutines+3 || last.HeapMB > first.HeapMB+8 {
		t.Errorf("growth over the cycles: goroutines %d → %d, heap %.1f → %.1f MB", first.Goroutines, last.Goroutines, first.HeapMB, last.HeapMB)
	}
	time.Sleep(time.Second)
	noLeaks(t, base)
	endHeap := heapAfterGC()
	out, _ := json.MarshalIndent(map[string]any{"cycles": cycles, "baseHeapMB": baseHeap, "endHeapMB": endHeap, "samples": samples}, "", "  ")
	t.Logf("soak:\n%s", out)
	if f := os.Getenv("SOAK_OUT"); f != "" {
		_ = os.WriteFile(f, out, 0o644)
	}
	// A1: resources come back after the cycles. Some growth is allowed for
	// caches that fill once (discovery, TLS sessions); a leak grows with cycles.
	if limit := baseHeap*1.5 + 16; endHeap > limit {
		t.Fatalf("heap after %d cycles: %.1f MB, at the start %.1f MB (limit %.1f MB)", cycles, endHeap, baseHeap, limit)
	}
}
