package kube

import (
	"context"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// stop cancels what a connection owns; done closes once all of it ended, and
// nothing new starts after stop.
func TestStopWaitsForOwnedGoroutines(t *testing.T) {
	c, _, _ := newFakeConn(t, pod("a", nil))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := c.start(ctx, "tester", true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "synced", c.synced)
	var ended atomic.Bool
	c.own("slow to end", nil, func() {
		<-c.ctx.Done()
		time.Sleep(100 * time.Millisecond)
		ended.Store(true)
	})
	c.stop()
	if !c.waitStopped(5 * time.Second) {
		t.Fatal("owned goroutines did not end")
	}
	if !ended.Load() {
		t.Fatal("done closed before an owned goroutine ended")
	}
	var ran atomic.Bool
	c.own("after stop", nil, func() { ran.Store(true) })
	time.Sleep(50 * time.Millisecond)
	if ran.Load() {
		t.Fatal("a goroutine started after stop")
	}
}

// Shutdown reports running jobs as interrupted; their late result is dropped.
func TestShutdownInterruptsRunningJobs(t *testing.T) {
	m := activityManager(t)
	run := m.jobReg().start("drain-1", "Draining node-1", "dev-local", nil)
	run.progress(0.4, "2 of 5 evicted")
	m.Shutdown()
	jobs := m.Jobs()
	if len(jobs) != 1 || jobs[0].State != JobUnknown || !jobs[0].Done || jobs[0].Error == "" {
		t.Fatalf("job after shutdown = %+v", jobs)
	}
	run.succeed("5 evicted")
	if j := m.Jobs()[0]; j.State != JobUnknown {
		t.Fatalf("a job changed after it ended: %+v", j)
	}
}

// Shutdown closes log streams and leaves none of their goroutines behind.
func TestShutdownClosesStreams(t *testing.T) {
	c, _, _ := newFakeConn(t, pod("a", func(p *corev1.Pod) {
		p.Spec.Containers = []corev1.Container{{Name: "app"}}
		p.Status.Phase = corev1.PodRunning
	}))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.ctx = ctx
	m := managerWith(c, false)
	m.streams = streams{logs: map[string]*logStream{}, exec: map[string]*execSession{}}
	if _, err := m.StartLogs(LogsRequest{Cluster: "test", Namespace: "payments", Pods: []string{"a"}}); err != nil {
		t.Fatal(err)
	}
	m.Shutdown()
	m.streams.mu.Lock()
	n := len(m.streams.logs)
	m.streams.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d log streams left open", n)
	}
}

// A connection that is ending and its replacement save and load the same
// samples file at the same time: every read sees a whole file.
func TestSamplesFileIsNeverWrittenTwiceAtOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "samples.json")
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(2)
		go func() {
			defer wg.Done()
			s := newSampleStore(120)
			for j := range 200 {
				s.add("ns/p/c", time.Now().Add(time.Duration(j)*time.Second), float32(i))
			}
			for range 20 {
				_ = s.save(path)
			}
		}()
		go func() {
			defer wg.Done()
			for range 20 {
				s := newSampleStore(120)
				s.load(path, time.Now(), time.Hour)
				if n := s.len(); n != 0 && n != 1 {
					t.Errorf("loaded %d series", n)
				}
			}
		}()
	}
	wg.Wait()
}
