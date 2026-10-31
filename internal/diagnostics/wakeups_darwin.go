//go:build darwin && cgo

package diagnostics

/*
#include <libproc.h>
#include <sys/resource.h>
#include <unistd.h>

// Idle and interrupt wakeups of this process since it started, as the kernel
// counts them for energy accounting (top's IDLEW is the idle part).
static long long clustrail_wakeups(void) {
	struct rusage_info_v2 ri;
	if (proc_pid_rusage(getpid(), RUSAGE_INFO_V2, (rusage_info_t *)&ri) != 0) return -1;
	return (long long)(ri.ri_pkg_idle_wkups + ri.ri_interrupt_wkups);
}
*/
import "C"

// wakeups on macOS: getrusage leaves the context switch counters at 0, so the
// kernel's own wakeup counters are read instead.
func wakeups(rusage) int64 {
	n := int64(C.clustrail_wakeups())
	if n < 0 {
		return 0
	}
	return n
}
