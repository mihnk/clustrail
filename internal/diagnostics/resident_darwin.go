//go:build darwin && cgo

package diagnostics

/*
#include <libproc.h>
#include <sys/resource.h>
#include <unistd.h>

static long long clustrail_resident(void) {
	struct rusage_info_v2 ri;
	if (proc_pid_rusage(getpid(), RUSAGE_INFO_V2, (rusage_info_t *)&ri) != 0) return -1;
	return (long long)ri.ri_resident_size;
}
*/
import "C"

// ResidentMB is this process's resident memory (the WebKit processes on
// macOS are separate and not included).
func ResidentMB() float64 {
	n := int64(C.clustrail_resident())
	if n < 0 {
		return 0
	}
	return float64(n) / (1 << 20)
}
