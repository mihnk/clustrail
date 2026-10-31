package kube

import (
	"context"
	"time"
)

// A flush loop that has nothing to send stops its ticker and waits for a
// kick, so an idle app does not wake every few hundred milliseconds per
// cluster, list and log tab. Whoever marks something dirty kicks.
type kicker chan struct{}

func newKicker() kicker { return make(chan struct{}, 1) }

// kick never blocks; a kick that arrives while the loop is busy is kept, so
// one that comes between "nothing to send" and waiting is not lost.
func (k kicker) kick() {
	select {
	case k <- struct{}{}:
	default:
	}
}

// quietAfter empty flushes stop the ticker.
const quietAfter = 4

// flushUntilQuiet calls flush every interval while it reports work (or is
// waiting for a cache to sync); after quietAfter flushes in a row with
// nothing to send it waits for a kick, then ticks again. Batching and the
// latency of a change (at most one interval) stay the same.
func flushUntilQuiet(ctx context.Context, loop string, interval time.Duration, k kicker, flush func() bool) {
	t := time.NewTicker(interval)
	defer t.Stop()
	empty := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		wake(loop)
		if flush() {
			// A kick for work this flush (or the next ones) covers is stale:
			// at least quietAfter more flushes look before the loop sleeps.
			select {
			case <-k:
			default:
			}
			empty = 0
			continue
		}
		if empty++; empty < quietAfter {
			continue
		}
		t.Stop()
		select {
		case <-ctx.Done():
			return
		case <-k:
		}
		empty = 0
		t.Reset(interval)
	}
}
