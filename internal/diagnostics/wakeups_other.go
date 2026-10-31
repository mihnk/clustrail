//go:build !(darwin && cgo)

package diagnostics

// wakeups elsewhere: voluntary context switches, the process going to sleep
// and waking again (0 where usage is not measured).
func wakeups(u rusage) int64 { return u.voluntary }
