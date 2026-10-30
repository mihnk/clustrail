package kube

import (
	"context"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func (r *recorder) logBatches() []LogBatch {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []LogBatch
	for _, e := range r.events {
		if b, ok := e.data.(LogBatch); ok {
			out = append(out, b)
		}
	}
	return out
}

func (r *recorder) logLines(event string) []LogLine {
	var out []LogLine
	for _, b := range r.logBatches() {
		for _, l := range b.Lines {
			if l.Event == event {
				out = append(out, l)
			}
		}
	}
	return out
}

func (r *recorder) lastPods() []LogPod {
	var pods []LogPod
	for _, b := range r.logBatches() {
		if b.Pods != nil {
			pods = b.Pods
		}
	}
	return pods
}

func logManager(c *clusterConn) *Manager {
	m := managerWith(c, false)
	m.streams = streams{logs: map[string]*logStream{}, exec: map[string]*execSession{}}
	if c.ctx == nil {
		c.ctx = context.Background()
	}
	return m
}

func TestSelectorLogsFollowPodsThatJoinAndLeave(t *testing.T) {
	defer func(d time.Duration) { logMembershipInterval = d }(logMembershipInterval)
	logMembershipInterval = 50 * time.Millisecond
	old := pod("checkout-api-7d9f8b6c4-a1", func(p *corev1.Pod) { p.Labels["pod-template-hash"] = "7d9f8b6c4" })
	other := pod("cart-api-1", func(p *corev1.Pod) { p.Labels = map[string]string{"app": "cart-api"} })
	c, client, rec := newFakeConn(t, old, other)
	m := logManager(c)

	id, err := m.StartLogs(LogsRequest{
		Cluster:   "test",
		Sources:   []LogSourceSpec{{Namespace: "payments", Selector: "app=checkout-api"}},
		FollowNew: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer m.StopLogs(id)
	waitFor(t, "initial pod", func() bool {
		ps := rec.lastPods()
		return len(ps) == 1 && ps[0].Pod == old.Name && ps[0].Initial && ps[0].Revision == "7d9f8b6c4"
	})
	if len(rec.logLines("joined")) != 0 {
		t.Fatal("pods present at the start get no joined marker")
	}

	fresh := pod("checkout-api-5b8c7f9d2-b2", func(p *corev1.Pod) { p.CreationTimestamp = metav1.Now() })
	if _, err := client.CoreV1().Pods("payments").Create(context.Background(), fresh, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "joined marker", func() bool { return len(rec.logLines("joined")) == 1 })
	if l := rec.logLines("joined")[0]; l.Pod != fresh.Name || l.Namespace != "payments" {
		t.Fatalf("joined = %+v", l)
	}

	if err := client.CoreV1().Pods("payments").Delete(context.Background(), old.Name, metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "left marker", func() bool { return len(rec.logLines("left")) == 1 })
	waitFor(t, "membership", func() bool {
		ps := rec.lastPods()
		return len(ps) == 2 && ps[0].State == "left" && ps[1].State == "following" && !ps[1].Initial
	})
	for _, b := range rec.logBatches() {
		for _, l := range b.Lines {
			if strings.HasPrefix(l.Pod, "cart-api") {
				t.Fatalf("pod outside the selector streamed: %+v", l)
			}
		}
	}
}

func TestLogsCapPodsAndKeepTheNewest(t *testing.T) {
	var objs []*corev1.Pod
	for i, age := range []time.Duration{3 * time.Hour, time.Hour, 2 * time.Hour} {
		objs = append(objs, pod("p"+string(rune('a'+i)), func(p *corev1.Pod) { p.CreationTimestamp = metav1.NewTime(time.Now().Add(-age)) }))
	}
	c, _, rec := newFakeConn(t, objs[0], objs[1], objs[2])
	m := logManager(c)
	id, err := m.StartLogs(LogsRequest{Cluster: "test", Sources: []LogSourceSpec{{Namespace: "payments", Selector: "app=checkout-api"}}, MaxPods: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer m.StopLogs(id)
	waitFor(t, "capped membership", func() bool {
		bs := rec.logBatches()
		if len(bs) == 0 {
			return false
		}
		last := bs[len(bs)-1]
		ps := rec.lastPods()
		return last.Matched == 3 && last.Skipped == 1 && len(ps) == 2
	})
	for _, p := range rec.lastPods() {
		if p.Pod == "pa" {
			t.Fatal("the oldest pod must be the one skipped")
		}
	}
}

func TestWorkloadSourceAndFixedPods(t *testing.T) {
	d := deployment(func(d *appsv1.Deployment) {
		d.Spec.Selector = &metav1.LabelSelector{MatchLabels: map[string]string{"app": "checkout-api"}}
	})
	a := pod("checkout-api-a", nil)
	extra := pod("cart-api-x", func(p *corev1.Pod) { p.Labels = map[string]string{"app": "cart-api"} })
	c, _, rec := newFakeConn(t, d, a, extra)
	m := logManager(c)
	id, err := m.StartLogs(LogsRequest{Cluster: "test", Containers: []string{"api"}, Sources: []LogSourceSpec{
		{Namespace: "payments", Workload: "Deployment/checkout-api"},
		{Namespace: "payments", Pods: []string{"cart-api-x"}},
		{Namespace: "payments", Workload: "CronJob/nightly"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer m.StopLogs(id)
	waitFor(t, "both sources", func() bool { return len(rec.lastPods()) == 2 })
	if ps := rec.lastPods(); ps[0].Pod != "cart-api-x" || ps[1].Pod != "checkout-api-a" {
		t.Fatalf("pods = %+v (fixed pods come first)", ps)
	}
	if f := rec.logLines("failed"); len(f) != 1 || !strings.Contains(f[0].Msg, "CronJob") {
		t.Fatalf("unsupported workload should say so once: %+v", f)
	}
	waitFor(t, "container states", func() bool {
		for _, b := range rec.logBatches() {
			for _, st := range b.States {
				if st.Container == "envoy" {
					t.Fatalf("container filter ignored: %+v", st)
				}
				if st.Pod == "checkout-api-a" && st.Container == "api" {
					return true
				}
			}
		}
		return false
	})
}
