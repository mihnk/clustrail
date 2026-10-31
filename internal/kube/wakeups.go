package kube

import (
	"sync"
	"sync/atomic"
)

// Timer-driven loops count each time they wake, so a benchmark can show what
// an idle app still does (Diagnostics › wakeups). Counting is one atomic add.
var wakeups sync.Map // loop name → *atomic.Int64

func wake(loop string) {
	v, ok := wakeups.Load(loop)
	if !ok {
		v, _ = wakeups.LoadOrStore(loop, new(atomic.Int64))
	}
	v.(*atomic.Int64).Add(1)
}

// Wakeups returns how often each timer-driven loop woke since the start.
func Wakeups() map[string]int64 {
	out := map[string]int64{}
	wakeups.Range(func(k, v any) bool {
		out[k.(string)] = v.(*atomic.Int64).Load()
		return true
	})
	return out
}
