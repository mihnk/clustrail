package kube

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func activityManager(t *testing.T) *Manager {
	t.Helper()
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config")
	writeKubeconfig(t, cfg, "https://127.0.0.1:1", "token")
	t.Setenv("KUBECONFIG", cfg)
	store, err := OpenStore(filepath.Join(dir, "contexts.json"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m := NewManager(ctx, store, &recorder{})
	t.Cleanup(m.Shutdown)
	return m
}

func shortQuiet(t *testing.T) {
	oldPause, oldSpread := pauseAfter, wakeSpread
	pauseAfter, wakeSpread = 80*time.Millisecond, 30*time.Millisecond
	t.Cleanup(func() { pauseAfter, wakeSpread = oldPause, oldSpread })
}

func TestBackgroundSlowsDownAndPausesThenResumes(t *testing.T) {
	shortQuiet(t)
	m := activityManager(t)
	c := fakeConnected(t, m)
	c.slowdown = m.activity.slowdown
	if c.slow() != 1 {
		t.Fatal("foreground: normal intervals")
	}
	m.SetHidden(HiddenMinimised, true)
	if st, _ := m.Activity(); st != Background || c.slow() != time.Duration(backgroundSlowdown) {
		t.Fatalf("minimised: state %s, slowdown %d", st, c.slow())
	}
	waitUntil(t, "watches to pause", func() bool { return stateOf(m, "dev-local").Paused })
	if cur, _ := m.conn("dev-local"); cur != nil {
		t.Fatal("a paused cluster is disconnected")
	}
	m.SetHidden(HiddenMinimised, false)
	if st := stateOf(m, "dev-local"); st.Paused || (st.Connection != Connecting && st.Connection != Unreachable) {
		t.Fatalf("back in front: %+v", st)
	}
}

func TestEverySourceMustBeVisible(t *testing.T) {
	m := activityManager(t)
	m.SetHidden(HiddenPage, true)
	m.SetHidden(HiddenMinimised, true)
	m.SetHidden(HiddenMinimised, false)
	if st, _ := m.Activity(); st != Background {
		t.Fatal("still hidden by the page")
	}
	m.SetHidden(HiddenPage, false)
	if st, _ := m.Activity(); st != Foreground {
		t.Fatal("nothing hides it any more")
	}
}

func TestAShortSpellInTheBackgroundPausesNothing(t *testing.T) {
	shortQuiet(t)
	m := activityManager(t)
	fakeConnected(t, m)
	m.SetHidden(HiddenPage, true)
	m.SetHidden(HiddenPage, false)
	time.Sleep(3 * pauseAfter)
	if c, _ := m.conn("dev-local"); c == nil || stateOf(m, "dev-local").Paused {
		t.Fatal("back in front before the pause: nothing paused")
	}
}

func TestALatePauseCannotUndoAResume(t *testing.T) {
	shortQuiet(t)
	m := activityManager(t)
	fakeConnected(t, m)
	m.SetHidden(HiddenPage, true)
	_, gen := m.Activity()
	m.SetHidden(HiddenPage, false)
	m.SetHidden(HiddenPage, true) // a new spell: a new generation
	m.pauseFor(gen)               // the first spell's timer, late
	if c, _ := m.conn("dev-local"); c == nil {
		t.Fatal("a pause for an older generation must do nothing")
	}
	m.SetHidden(HiddenPage, false)
}

func TestThePauseSettingIsHonoured(t *testing.T) {
	shortQuiet(t)
	m := activityManager(t)
	fakeConnected(t, m)
	m.SetPauseInBackground(false)
	m.SetHidden(HiddenApp, true)
	time.Sleep(3 * pauseAfter)
	if c, _ := m.conn("dev-local"); c == nil {
		t.Fatal("pausing is off: the cluster stays connected")
	}
}

func TestBackInFrontProbesEveryConnectionOnce(t *testing.T) {
	shortQuiet(t)
	m := activityManager(t)
	c := fakeConnected(t, m)
	m.SetPauseInBackground(false)
	m.SetHidden(HiddenPage, true)
	m.SetHidden(HiddenPage, false)
	waitUntil(t, "a probe kick", func() bool { return len(c.probeKick) == 1 })
}

func TestSleepIsNoticedFromTheClocks(t *testing.T) {
	if sleptBetween(10*time.Second, 10*time.Second, 5*time.Second) {
		t.Fatal("no gap: no sleep")
	}
	if !sleptBetween(10*time.Minute, 10*time.Second, 5*time.Second) {
		t.Fatal("the wall clock jumped: the machine slept")
	}
	now := time.Now()
	if slept(now, now.Add(10*time.Second), 5*time.Second) {
		t.Fatal("readings from one running clock never look like sleep")
	}
}
