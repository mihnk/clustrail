//go:build unix

package diagnostics

import (
	"syscall"
	"time"
)

// processCPU is user + system CPU time of this process.
func processCPU() time.Duration {
	var ru syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &ru) != nil {
		return 0
	}
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano())
}
