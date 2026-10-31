//go:build unix

package diagnostics

import (
	"syscall"
	"time"
)

// processCPU is user + system CPU time of this process.
func processCPU() time.Duration {
	u := usage()
	return u.cpu
}

type rusage struct {
	cpu                    time.Duration
	voluntary, involuntary int64
}

// usage reads this process's CPU time and context switches. A voluntary
// switch is the process going to sleep and waking again: a proxy for wakeups.
func usage() rusage {
	var ru syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &ru) != nil {
		return rusage{}
	}
	return rusage{cpu: time.Duration(ru.Utime.Nano() + ru.Stime.Nano()), voluntary: int64(ru.Nvcsw), involuntary: int64(ru.Nivcsw)}
}
