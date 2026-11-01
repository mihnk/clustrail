package kube

import (
	"context"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"
)

// Quiet mode (issue B3): one foreground / background / asleep state for the
// whole app, from the native window state and the page's visibility.
//
//   - Background (every window hidden or minimised, the app hidden, or the
//     page not visible): probes and metrics slow down; after pauseAfter,
//     watches pause if the user allows it (Settings › Refresh & watch).
//     Clusters with a log stream, shell or port forward stay connected.
//   - Foreground again: paused watches resume and every connection is
//     probed once, spread over a moment.
//   - Wake from sleep (the wall clock jumped ahead of the monotonic one):
//     every connection is probed once, with jitter, so twenty clusters do
//     not reconnect in the same instant.
//
// Every transition has a generation; work scheduled for one generation (the
// pause timer) does nothing once a later transition happened, so a late pause
// cannot undo a resume.

type ActivityState string

const (
	Foreground ActivityState = "foreground"
	Background ActivityState = "background"
)

var (
	// pauseAfter is how long the app stays in the background before watches pause.
	pauseAfter = 5 * time.Minute
	// backgroundSlowdown multiplies probe and metrics intervals in the background.
	backgroundSlowdown = 4
	// wakeSpread is the window over which connections are probed after a wake or a return to the foreground.
	wakeSpread = 3 * time.Second
	// sleepCheckEvery is how often the clock is compared to notice a sleep.
	sleepCheckEvery = 10 * time.Second
)

// Hidden reasons, each reported by its own source.
const (
	HiddenPage      = "page"      // document.visibilityState (the UI)
	HiddenMinimised = "minimised" // every window minimised or hidden (native)
	HiddenApp       = "app"       // the application hidden (macOS ⌘H)
)

type activity struct {
	mu         sync.Mutex
	hidden     map[string]bool
	state      ActivityState
	gen        uint64
	since      time.Time
	pauseOK    bool // Settings › Pause watches in the background
	pauseTimer *time.Timer
	paused     bool // watches were paused for this background spell
}

func newActivity() *activity {
	return &activity{hidden: map[string]bool{}, state: Foreground, since: time.Now(), pauseOK: true}
}

// slowdown is the factor for probe and metrics intervals now.
func (a *activity) slowdown() int {
	if a == nil {
		return 1
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.state == Background {
		return backgroundSlowdown
	}
	return 1
}

// Activity reports the current state and its generation.
func (m *Manager) Activity() (ActivityState, uint64) {
	a := m.activity
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.state, a.gen
}

// SetPauseInBackground follows Settings › Pause watches in the background.
func (m *Manager) SetPauseInBackground(on bool) {
	a := m.activity
	a.mu.Lock()
	a.pauseOK = on
	if !on && a.pauseTimer != nil {
		a.pauseTimer.Stop()
		a.pauseTimer = nil
	}
	a.mu.Unlock()
}

// SetHidden records one source's view; the app is in the background while any source says hidden.
func (m *Manager) SetHidden(source string, hidden bool) {
	a := m.activity
	a.mu.Lock()
	a.hidden[source] = hidden
	next := Foreground
	for _, h := range a.hidden {
		if h {
			next = Background
		}
	}
	if next == a.state {
		a.mu.Unlock()
		return
	}
	a.state, a.since = next, time.Now()
	a.gen++
	gen := a.gen
	if a.pauseTimer != nil {
		a.pauseTimer.Stop()
		a.pauseTimer = nil
	}
	resume := false
	if next == Background {
		if a.pauseOK {
			a.pauseTimer = time.AfterFunc(pauseAfter, func() { m.pauseFor(gen) })
		}
	} else if a.paused {
		a.paused, resume = false, true
	}
	a.mu.Unlock()
	slog.Info("activity", "state", next, "generation", gen)
	if next == Foreground {
		if resume {
			m.ResumeWatches()
		}
		m.probeAllSoon("foreground")
	}
}

// pauseFor pauses watches if the app is still in the background spell gen started.
func (m *Manager) pauseFor(gen uint64) {
	a := m.activity
	a.mu.Lock()
	if a.gen != gen || a.state != Background || !a.pauseOK {
		a.mu.Unlock()
		return
	}
	a.mu.Unlock()
	ids := m.PauseWatches()
	if len(ids) == 0 {
		return
	}
	a.mu.Lock()
	if a.gen == gen {
		a.paused = true
		a.mu.Unlock()
		return
	}
	// Back in the foreground while pausing: that transition did not know of
	// this pause, so it is undone here.
	a.mu.Unlock()
	m.ResumeWatches()
}

// probeAllSoon probes every connection once, spread over wakeSpread.
func (m *Manager) probeAllSoon(why string) {
	m.mu.Lock()
	conns := make([]*clusterConn, 0, len(m.conns))
	for _, c := range m.conns {
		conns = append(conns, c)
	}
	m.mu.Unlock()
	for _, c := range conns {
		delay := time.Duration(rand.Int64N(int64(wakeSpread) + 1))
		time.AfterFunc(delay, func() { c.probeKick.kick() })
	}
	if len(conns) > 0 {
		slog.Info("probing connections", "why", why, "count", len(conns))
	}
}

// slept reports whether the wall clock moved ahead of the monotonic clock by
// more than the tolerance between two readings: the machine slept (the
// monotonic clock stops during sleep on macOS and Linux).
func slept(prev, now time.Time, tolerance time.Duration) bool {
	return sleptBetween(now.Round(0).Sub(prev.Round(0)), now.Sub(prev), tolerance)
}

// sleptBetween compares the wall and monotonic time that passed.
func sleptBetween(wall, mono, tolerance time.Duration) bool { return wall-mono > tolerance }

// sleepWatch probes every connection once after the machine wakes.
func (m *Manager) sleepWatch(ctx context.Context) {
	prev := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(sleepCheckEvery):
		}
		now := time.Now()
		if slept(prev, now, 5*time.Second) {
			slog.Info("woke from sleep", "asleep", now.Round(0).Sub(prev.Round(0))-now.Sub(prev))
			m.probeAllSoon("wake")
		}
		prev = now
	}
}
