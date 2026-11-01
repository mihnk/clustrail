package kube

import (
	"fmt"
	"runtime"
	"testing"
	"time"
)

// Pods that crash and are deleted with new names every time: the alert
// state and the metric series follow the pods that exist.
func TestHoldersStayBoundedUnderChurn(t *testing.T) {
	d := newAlertDetector()
	for i := range 1000 {
		p := crashing(3)
		p.Name = fmt.Sprintf("job-%d", i)
		d.pod(p, false, true)
		d.pod(p, true, true)
	}
	d.mu.Lock()
	active, oom := len(d.active), len(d.oomSeen)
	d.mu.Unlock()
	if active != 0 || oom != 0 {
		t.Fatalf("alert state after churn: %d active, %d OOM entries", active, oom)
	}

	s := newSampleStore(120)
	now := time.Now()
	for i := range 1000 {
		s.add(fmt.Sprintf("payments/job-%d/main", i), now, 1)
		live := fmt.Sprintf("payments/job-%d", i)
		s.forget(func(key string) bool { return len(key) > len(live) && key[:len(live)] == live })
	}
	if n := s.len(); n != 1 {
		t.Fatalf("series after churn = %d, want only the live pod's", n)
	}
}

func TestMemoryStatsReportTheProcessApartFromTheHeap(t *testing.T) {
	m := activityManager(t)
	st := m.MemoryStats()
	// Two readings a moment apart: the family may read a little lower than the process alone.
	if runtime.GOOS == "linux" && (st.ProcessMB <= 0 || float64(st.AppMB) < 0.9*float64(st.ProcessMB)) {
		t.Fatalf("process %d MB, app %d MB", st.ProcessMB, st.AppMB)
	}
	for _, k := range []string{"log streams", "shells", "list watches", "port forwards"} {
		if _, ok := st.Holders[k]; !ok {
			t.Errorf("holder %q is not reported", k)
		}
	}
}
