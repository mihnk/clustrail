//go:build !unix

package diagnostics

import "time"

// processCPU is not measured on this platform yet; CPUPercent stays 0.
func processCPU() time.Duration { return 0 }

type rusage struct {
	cpu                    time.Duration
	voluntary, involuntary int64
}

func usage() rusage { return rusage{} }
