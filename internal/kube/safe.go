package kube

import (
	"context"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync/atomic"
	"time"
)

// Every goroutine in this package starts through safeGo or safeLoop (a test
// enforces it): a panic in one component is recovered and logged with its
// stack instead of ending the app with every open shell, log stream and port
// forward.

// panicNotice is told about each recovered panic; NewManager shows a notice.
var panicNotice atomic.Pointer[func(component string)]

// safeGo runs fn in a goroutine. After a panic, onPanic (when set) puts the
// component in a defined state, such as a failed job.
func safeGo(component string, onPanic func(error), fn func()) {
	go runSafe(component, onPanic, fn)
}

// runSafe runs fn and reports whether it panicked.
func runSafe(component string, onPanic func(error), fn func()) (panicked bool) {
	defer func() {
		r := recover()
		if r == nil {
			return
		}
		panicked = true
		err := fmt.Errorf("internal error in %s: %v", component, r)
		slog.Error("recovered from a panic", "component", component, "panic", fmt.Sprint(r), "stack", string(debug.Stack()))
		if h := panicNotice.Load(); h != nil {
			(*h)(component)
		}
		if onPanic != nil {
			func() {
				defer func() {
					if r := recover(); r != nil {
						slog.Error("panic while handling a panic", "component", component, "panic", fmt.Sprint(r))
					}
				}()
				onPanic(err)
			}()
		}
	}()
	fn()
	return false
}

// A loop that panics is restarted after loopRestartDelay, at most
// loopRestarts times; then giveUp makes the failure visible.
var (
	loopRestarts     = 3
	loopRestartDelay = time.Second
)

// safeLoop runs a long-lived loop in a goroutine and restarts it after a
// panic while ctx is alive. A loop that returns ends for good.
func safeLoop(ctx context.Context, component string, giveUp func(error), loop func()) {
	go func() {
		for restarts := 0; ; restarts++ {
			var last error
			if !runSafe(component, func(err error) { last = err }, loop) || ctx.Err() != nil {
				return
			}
			if restarts >= loopRestarts {
				if giveUp != nil {
					runSafe(component+" (giving up)", nil, func() { giveUp(last) })
				}
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(loopRestartDelay):
			}
		}
	}()
}
