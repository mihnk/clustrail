package kube

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"helm.sh/helm/v4/pkg/action"
	chartv2 "helm.sh/helm/v4/pkg/chart/v2"
	kubefake "helm.sh/helm/v4/pkg/kube/fake"
	"helm.sh/helm/v4/pkg/release/common"
	releasev1 "helm.sh/helm/v4/pkg/release/v1"
	"helm.sh/helm/v4/pkg/storage"
	"helm.sh/helm/v4/pkg/storage/driver"
)

// Every change carries a growing sequence number; a finished job does not
// change again, and its result can be read again later.
func TestJobRegistryOrdersAndKeepsResults(t *testing.T) {
	var sent []Job
	r := newJobRegistry(func(j Job) { sent = append(sent, j) })
	run := r.start("j1", "Draining a", "prod", nil)
	run.progress(0.5, "half")
	run.succeed("done")
	run.progress(0.7, "late") // after the result: dropped
	run.fail(errors.New("late failure"))
	if len(sent) != 3 {
		t.Fatalf("sent %d events: %+v", len(sent), sent)
	}
	for i := 1; i < len(sent); i++ {
		if sent[i].Seq <= sent[i-1].Seq {
			t.Fatalf("seq not growing: %+v", sent)
		}
	}
	if last := r.list()[0]; last.State != JobSucceeded || !last.Done || last.Detail != "done" || last.Finished == 0 {
		t.Fatalf("kept result = %+v", last)
	}
	for i := range keepFinished + 5 {
		r.start(strings.Repeat("x", i+1), "t", "c", nil).fail(errors.New("x"))
	}
	if n := len(r.list()); n != keepFinished {
		t.Fatalf("%d finished jobs kept, want %d", n, keepFinished)
	}
}

// Cancelling says so while it stops, and is refused for jobs that cannot be
// cancelled or have finished.
func TestJobCancel(t *testing.T) {
	r := newJobRegistry(nil)
	ctx, cancel := context.WithCancel(context.Background())
	run := r.start("drain", "Draining a", "prod", cancel)
	if err := r.cancel("drain"); err != nil {
		t.Fatal(err)
	}
	if ctx.Err() == nil || !run.cancelled() || r.list()[0].State != JobCancelRequested {
		t.Fatalf("after cancel: %+v", r.list()[0])
	}
	run.progress(0.9, "still stopping")
	if r.list()[0].State != JobCancelRequested {
		t.Fatal("a progress report must not hide the cancel request")
	}
	run.fail(errors.New("cancelled"))
	if err := r.cancel("drain"); err == nil {
		t.Fatal("a finished job cannot be cancelled")
	}
	r.start("helm", "Upgrading b", "prod", nil)
	if err := r.cancel("helm"); err == nil {
		t.Fatal("a job without a cancel func cannot be cancelled")
	}
}

// Cancelling a drain stops it and says what stays: the node cordoned and the
// pods already evicted. Nothing claims to be undone.
func TestDrainCancelSaysWhatStays(t *testing.T) {
	defer func(d, min time.Duration) { drainPoll, drainMinTimeout = d, min }(drainPoll, drainMinTimeout)
	drainPoll, drainMinTimeout = 20*time.Millisecond, time.Minute
	m, rec, _, _ := drainFixture(t)
	id, err := m.DrainNode("test", "node-1", DrainOptions{}, "jane")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "slow terminating", func() bool { return strings.Contains(lastJob(rec).Detail, "1 terminating") })
	if err := m.CancelJob(id); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "drain done", func() bool { return lastJob(rec).Done })
	j := lastJob(rec)
	if j.State != JobFailed || !strings.Contains(j.Error, "cancelled") || !strings.Contains(j.Error, "not restored") || !strings.Contains(j.Error, "stays cordoned") {
		t.Fatalf("job = %+v", j)
	}
	if got := m.Jobs(); len(got) != 1 || got[0].ID != id || got[0].State != JobFailed {
		t.Fatalf("Jobs() = %+v", got)
	}
}

// A Helm call that returned an error is judged by the release as it is now:
// a new revision deployed after the wait gave up is a success, one still
// pending is unknown, and no new revision is the failure.
func TestHelmOutcomeReadsTheRelease(t *testing.T) {
	timeout := errors.New("context deadline exceeded")
	for _, tc := range []struct {
		name   string
		latest *releasev1.Release
		want   JobState
	}{
		{"late success", &releasev1.Release{Name: "api", Version: 2, Info: &releasev1.Info{Status: common.StatusDeployed}, Chart: &chartv2.Chart{}}, JobSucceeded},
		{"still pending", &releasev1.Release{Name: "api", Version: 2, Info: &releasev1.Info{Status: common.StatusPendingUpgrade}, Chart: &chartv2.Chart{}}, JobUnknown},
		{"never written", nil, JobFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := &action.Configuration{Releases: storage.Init(driver.NewMemory()), KubeClient: &kubefake.PrintingKubeClient{Out: io.Discard}}
			_ = cfg.Releases.Create(&releasev1.Release{Name: "api", Version: 1, Info: &releasev1.Info{Status: common.StatusSuperseded}, Chart: &chartv2.Chart{}})
			if tc.latest != nil {
				_ = cfg.Releases.Create(tc.latest)
			}
			r := newJobRegistry(nil)
			helmOutcome(r.start("h", "Upgrading api", "prod", nil), cfg, "api", 1, timeout)
			if j := r.list()[0]; j.State != tc.want {
				t.Fatalf("state = %s (%+v), want %s", j.State, j, tc.want)
			}
		})
	}
}
