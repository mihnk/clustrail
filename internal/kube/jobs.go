package kube

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"helm.sh/helm/v4/pkg/action"
)

// Background jobs (drain, Helm upgrade and rollback) and their results. Each
// change is sent to the UI as the whole job with a sequence number, so a late
// or repeated event can be told apart from a newer one; the list (running jobs
// and the latest results) can be read again, e.g. after a window reload.
//
// Three things stay separate: whether the API server is reachable (the
// cluster's connection state), how fresh cached data is (rows), and whether an
// operation completed (the job's state here).

type JobState string

const (
	JobQueued          JobState = "queued"
	JobRunning         JobState = "running"
	JobCancelRequested JobState = "cancel-requested"
	JobSucceeded       JobState = "succeeded"
	JobFailed          JobState = "failed"
	// JobUnknown: the operation may or may not have taken effect (the
	// connection closed, or the wait ended before the cluster answered).
	// Its outcome must be read from the cluster, never assumed.
	JobUnknown JobState = "unknown"
)

func (s JobState) terminal() bool {
	return s == JobSucceeded || s == JobFailed || s == JobUnknown
}

// Job is one background operation as the UI sees it.
type Job struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Cluster  string   `json:"cluster"`
	State    JobState `json:"state"`
	Progress float64  `json:"progress"`
	Detail   string   `json:"detail"`
	Error    string   `json:"error,omitempty"`
	// Done is a terminal state (succeeded, failed or unknown).
	Done bool `json:"done,omitempty"`
	// Seq grows with every change of any job: a smaller one is stale.
	Seq        int64 `json:"seq"`
	Started    int64 `json:"started"`            // unix ms
	Finished   int64 `json:"finished,omitempty"` // unix ms
	Cancelable bool  `json:"cancelable,omitempty"`
}

// keepFinished is how many finished jobs are kept to be read again.
const keepFinished = 30

type jobRegistry struct {
	mu      sync.Mutex
	seq     int64
	order   []string
	jobs    map[string]*Job
	cancels map[string]context.CancelFunc
	emit    func(Job)
}

func newJobRegistry(emit func(Job)) *jobRegistry {
	return &jobRegistry{jobs: map[string]*Job{}, cancels: map[string]context.CancelFunc{}, emit: emit}
}

// jobRun reports one job's progress and result.
type jobRun struct {
	r  *jobRegistry
	id string
}

// start registers a running job. cancel, if not nil, makes it cancelable.
func (r *jobRegistry) start(id, title, cluster string, cancel context.CancelFunc) jobRun {
	r.update(id, func(j *Job) {
		*j = Job{ID: id, Title: title, Cluster: cluster, State: JobRunning, Started: time.Now().UnixMilli(), Cancelable: cancel != nil}
		if cancel != nil {
			r.cancels[id] = cancel
		}
	})
	return jobRun{r, id}
}

// update changes a job under the lock and sends the result. A finished job
// does not change again: a late report after the result is dropped.
func (r *jobRegistry) update(id string, f func(*Job)) {
	r.mu.Lock()
	j, ok := r.jobs[id]
	if !ok {
		j = &Job{ID: id}
		r.jobs[id] = j
		r.order = append(r.order, id)
	} else if j.State.terminal() {
		r.mu.Unlock()
		return
	}
	f(j)
	r.seq++
	j.Seq = r.seq
	j.Done = j.State.terminal()
	if j.Done {
		j.Finished = time.Now().UnixMilli()
		j.Cancelable = false
		delete(r.cancels, id)
		r.prune()
	}
	snapshot := *j
	r.mu.Unlock()
	if r.emit != nil {
		r.emit(snapshot)
	}
}

// prune drops the oldest finished jobs beyond keepFinished. Caller holds mu.
func (r *jobRegistry) prune() {
	finished := 0
	for _, id := range r.order {
		if r.jobs[id].Done {
			finished++
		}
	}
	keep := r.order[:0]
	for _, id := range r.order {
		if r.jobs[id].Done && finished > keepFinished {
			finished--
			delete(r.jobs, id)
			continue
		}
		keep = append(keep, id)
	}
	r.order = keep
}

// interrupt ends every running job as unknown with why: the app is closing
// and cannot follow them to the end. A job never changes after it ended, so
// a late success or failure from its goroutine is dropped.
func (r *jobRegistry) interrupt(why string) {
	r.mu.Lock()
	var running []string
	for id, j := range r.jobs {
		if !j.State.terminal() {
			running = append(running, id)
		}
	}
	r.mu.Unlock()
	for _, id := range running {
		r.update(id, func(j *Job) { j.State, j.Error = JobUnknown, why })
	}
}

func (r *jobRegistry) list() []Job {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Job, 0, len(r.order))
	for _, id := range r.order {
		out = append(out, *r.jobs[id])
	}
	return out
}

func (r *jobRegistry) cancel(id string) error {
	r.mu.Lock()
	j, ok := r.jobs[id]
	cancel := r.cancels[id]
	r.mu.Unlock()
	switch {
	case !ok:
		return fmt.Errorf("no job %s", id)
	case j.Done:
		return fmt.Errorf("%s has already finished", j.Title)
	case cancel == nil:
		return fmt.Errorf("%s cannot be cancelled", j.Title)
	}
	r.update(id, func(j *Job) { j.State, j.Detail = JobCancelRequested, "stopping…" })
	cancel()
	return nil
}

func (j jobRun) progress(p float64, detail string) {
	j.r.update(j.id, func(x *Job) {
		if x.State != JobCancelRequested {
			x.State = JobRunning
		}
		x.Progress, x.Detail = p, detail
	})
}

func (j jobRun) succeed(detail string) {
	j.r.update(j.id, func(x *Job) { x.State, x.Progress, x.Detail = JobSucceeded, 1, detail })
}

func (j jobRun) fail(err error) {
	j.r.update(j.id, func(x *Job) { x.State, x.Error = JobFailed, err.Error() })
}

// unknown ends a job whose effect on the cluster is not known.
func (j jobRun) unknown(why string) {
	j.r.update(j.id, func(x *Job) { x.State, x.Error = JobUnknown, why })
}

// cancelled reports whether the user asked this job to stop.
func (j jobRun) cancelled() bool {
	j.r.mu.Lock()
	defer j.r.mu.Unlock()
	x, ok := j.r.jobs[j.id]
	return ok && x.State == JobCancelRequested
}

// jobReg is the manager's job registry, made on first use.
func (m *Manager) jobReg() *jobRegistry {
	m.jobsOnce.Do(func() {
		m.jobsReg = newJobRegistry(func(j Job) {
			if m.emit != nil {
				m.emit.Emit(EventJob, j)
			}
		})
	})
	return m.jobsReg
}

// Jobs lists the running jobs and the latest results, oldest first.
func (m *Manager) Jobs() []Job { return m.jobReg().list() }

// CancelJob asks a running job to stop. What it already changed in the
// cluster stays changed; its result says so.
func (m *Manager) CancelJob(id string) error { return m.jobReg().cancel(id) }

// helmOutcome ends a Helm job whose call returned an error by reading the
// release as it is now, so the result is what happened in the cluster: a new
// revision that was deployed after the wait gave up is a success, one still
// pending is unknown, anything else is the failure.
func helmOutcome(job jobRun, cfg *action.Configuration, name string, before int, callErr error) {
	cur, err := currentRelease(cfg, name)
	switch {
	case err != nil:
		job.unknown(fmt.Sprintf("%v · the release could not be read afterwards (%v); check its history", callErr, err))
	case cur.Version > before && cur.Info != nil && string(cur.Info.Status) == "deployed":
		job.succeed(fmt.Sprintf("revision %d deployed (it finished after the wait ended: %v)", cur.Version, callErr))
	case cur.Version > before && cur.Info != nil && strings.HasPrefix(string(cur.Info.Status), "pending"):
		job.unknown(fmt.Sprintf("%v · revision %d is still %s in the cluster; check its history", callErr, cur.Version, cur.Info.Status))
	default:
		job.fail(callErr)
	}
}
