//go:build !unix

package diagnostics

import "time"

// processCPU is not measured on this platform yet; CPUPercent stays 0.
func processCPU() time.Duration { return 0 }
