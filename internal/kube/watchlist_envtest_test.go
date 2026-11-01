//go:build envtest

package kube

// The memory spike of the initial list on a large cluster (issue C7): the
// peak Go heap while a connection fills its caches, measured with streaming
// lists (WatchList, the client-go default since 1.35) and without. Run once
// per mode; client-go reads the switch from the environment at start:
//
//	KUBEBUILDER_ASSETS=... KUBE_FEATURE_WatchListClient=true  LIST_PODS=10000 go test -tags envtest -run TestInitialListMemory -v ./internal/kube
//	KUBEBUILDER_ASSETS=... KUBE_FEATURE_WatchListClient=false LIST_PODS=10000 go test -tags envtest -run TestInitialListMemory -v ./internal/kube

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestInitialListMemory(t *testing.T) {
	bins := envtestBins(t)
	pods := envInt("LIST_PODS", 10000)
	// LIST_SERVER_WATCHLIST=false: an API server without streaming lists (client-go falls back to a plain list).
	serverGate := "true"
	if os.Getenv("LIST_SERVER_WATCHLIST") == "false" {
		serverGate = "false"
	}
	env := startEnvCluster(t, bins, "--feature-gates=WatchList="+serverGate)
	admin := adminClient(t, env.host)
	ctx := context.Background()
	_, _ = admin.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "big"}}, metav1.CreateOptions{})
	var wg sync.WaitGroup
	sem := make(chan struct{}, 32)
	for i := range pods {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			p := richPod(i)
			p.Namespace, p.ResourceVersion, p.UID, p.ManagedFields, p.Status, p.OwnerReferences = "big", "", "", nil, corev1.PodStatus{}, nil
			p.Spec.NodeName = ""
			if _, err := admin.CoreV1().Pods("big").Create(ctx, p, metav1.CreateOptions{}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()

	runtime.GC()
	var peak atomic.Uint64
	stop := make(chan struct{})
	go func() {
		var ms runtime.MemStats
		for {
			select {
			case <-stop:
				return
			case <-time.After(5 * time.Millisecond):
			}
			runtime.ReadMemStats(&ms)
			for {
				p := peak.Load()
				if ms.HeapInuse <= p || peak.CompareAndSwap(p, ms.HeapInuse) {
					break
				}
			}
		}
	}()
	var base runtime.MemStats
	runtime.ReadMemStats(&base)
	start := time.Now()
	m := chaosManager(t, env.host) // returns once connected: the caches are filled
	for !m.conns["envtest"].synced() {
		time.Sleep(10 * time.Millisecond)
	}
	elapsed := time.Since(start)
	close(stop)
	runtime.GC()
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	mode := os.Getenv("KUBE_FEATURE_WatchListClient")
	if mode == "" {
		mode = "default (on)"
	}
	res := map[string]any{
		"watchListClient": mode, "serverWatchList": serverGate, "pods": pods,
		"peakHeapMB":   float64(peak.Load()-base.HeapInuse) / (1 << 20),
		"steadyHeapMB": float64(after.HeapInuse-base.HeapInuse) / (1 << 20),
		"syncMs":       elapsed.Milliseconds(),
	}
	out, _ := json.MarshalIndent(res, "", "  ")
	t.Logf("initial list:\n%s", out)
	if f := os.Getenv("LIST_OUT"); f != "" {
		_ = os.WriteFile(f, out, 0o644)
	}
	if got := len(shownPods(m, "big")); got != pods {
		t.Fatal(fmt.Sprintf("shown %d pods of %d", got, pods))
	}
}
