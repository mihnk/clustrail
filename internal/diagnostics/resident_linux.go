//go:build linux

package diagnostics

import (
	"os"
	"strconv"
	"strings"
)

// ResidentMB is this process's resident memory, from /proc/self/statm.
func ResidentMB() float64 {
	raw, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0
	}
	f := strings.Fields(string(raw))
	if len(f) < 2 {
		return 0
	}
	pages, _ := strconv.ParseFloat(f[1], 64)
	return pages * float64(os.Getpagesize()) / (1 << 20)
}
