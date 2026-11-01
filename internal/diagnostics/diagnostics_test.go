package diagnostics

import (
	"runtime"
	"testing"
	"time"
)

// A process that sleeps and wakes again is counted, on every platform that
// measures wakeups (on macOS getrusage alone would report 0).
func TestSampleCountsWakeups(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("wakeups are not measured on " + runtime.GOOS)
	}
	before := Sample()
	for range 50 {
		time.Sleep(5 * time.Millisecond)
	}
	after := Sample()
	if after.Wakeups <= before.Wakeups {
		t.Fatalf("wakeups did not grow across 50 sleeps: %d → %d", before.Wakeups, after.Wakeups)
	}
	if after.CPUTimeMs <= 0 {
		t.Fatalf("no CPU time: %+v", after)
	}
}

func TestResidentMemoryIsMeasured(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("not measured here")
	}
	if mb := ResidentMB(); mb < 1 || mb > 1<<16 {
		t.Fatalf("resident = %.1f MB", mb)
	}
}
