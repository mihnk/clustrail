// Package diagnostics reports the Go process's resource use for the
// development diagnostics view and the benchmark runner.
package diagnostics

import (
	"runtime"
	"sync"
	"time"
)

// Process is a point-in-time view of the Go side (not the WebView, which is
// a separate process on every platform).
type Process struct {
	CPUPercent   float64 `json:"cpuPercent"` // since the previous sample, of one core
	HeapAllocMB  float64 `json:"heapAllocMB"`
	HeapInuseMB  float64 `json:"heapInuseMB"`
	SysMB        float64 `json:"sysMB"`
	TotalAllocMB float64 `json:"totalAllocMB"`
	NumGC        uint32  `json:"numGC"`
	GCPauseMs    float64 `json:"gcPauseMs"` // total pause since start
	GCCPU        float64 `json:"gcCPU"`     // fraction of CPU spent in GC since start
	Goroutines   int     `json:"goroutines"`
}

var (
	mu       sync.Mutex
	lastCPU  time.Duration
	lastWall time.Time
)

// Sample reads the runtime counters. CPU is measured between calls.
func Sample() Process {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	p := Process{
		HeapAllocMB: mb(ms.HeapAlloc), HeapInuseMB: mb(ms.HeapInuse), SysMB: mb(ms.Sys), TotalAllocMB: mb(ms.TotalAlloc),
		NumGC: ms.NumGC, GCPauseMs: float64(ms.PauseTotalNs) / 1e6, GCCPU: ms.GCCPUFraction, Goroutines: runtime.NumGoroutine(),
	}
	cpu := processCPU()
	now := time.Now()
	mu.Lock()
	if !lastWall.IsZero() && cpu > 0 {
		if wall := now.Sub(lastWall); wall > 0 {
			p.CPUPercent = 100 * float64(cpu-lastCPU) / float64(wall)
		}
	}
	lastCPU, lastWall = cpu, now
	mu.Unlock()
	return p
}

func mb(b uint64) float64 { return float64(b) / (1 << 20) }
