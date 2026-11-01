//go:build !unix

package diagnostics

import "time"

type rusage struct {
	cpu                    time.Duration
	voluntary, involuntary int64
}

func usage() rusage { return rusage{} }
