package kube

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func crashing(restarts int32) *corev1.Pod {
	return pod("api-1", func(p *corev1.Pod) {
		p.Spec.Containers = []corev1.Container{{Name: "api", Resources: corev1.ResourceRequirements{Limits: corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("512Mi")}}}}
		p.Status.ContainerStatuses = []corev1.ContainerStatus{{
			Name: "api", RestartCount: restarts,
			State:                corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}},
			LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 1, Reason: "Error"}},
		}}
	})
}

func running(p *corev1.Pod) *corev1.Pod {
	p = p.DeepCopy()
	p.Status.ContainerStatuses[0].State = corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}
	p.Status.ContainerStatuses[0].Ready = true
	return p
}

func oom(p *corev1.Pod, restarts int32) *corev1.Pod {
	p = p.DeepCopy()
	p.Status.ContainerStatuses[0].RestartCount = restarts
	p.Status.ContainerStatuses[0].LastTerminationState.Terminated = &corev1.ContainerStateTerminated{ExitCode: 137, Reason: "OOMKilled"}
	return p
}

func kinds(as []Alert) []string {
	out := []string{}
	for _, a := range as {
		out = append(out, a.Kind)
	}
	return out
}

func TestAlertsTellTransitionsOnce(t *testing.T) {
	d := newAlertDetector()
	// Already crashing when the cache filled: not news.
	if got := d.pod(crashing(4), false, false); len(got) != 0 {
		t.Fatalf("before sync: %v", got)
	}
	if got := d.pod(crashing(5), false, true); len(got) != 0 {
		t.Fatalf("still crashing, already known: %v", got)
	}
	if got := kinds(d.pod(running(crashing(5)), false, true)); len(got) != 1 || got[0] != "recovered" {
		t.Fatalf("recovery: %v", got)
	}
	got := d.pod(crashing(6), false, true)
	if len(got) != 1 || got[0].Kind != "crashloop" || !strings.Contains(got[0].Detail, "last exit 1 (Error)") || got[0].Object != "api-1" {
		t.Fatalf("crashing again: %+v", got)
	}
	if again := d.pod(crashing(7), false, true); len(again) != 0 {
		t.Fatalf("told twice: %v", again)
	}
	// A deleted pod is forgotten: the same name crashing later is news.
	d.pod(crashing(7), true, true)
	if got := kinds(d.pod(crashing(0), false, true)); len(got) != 1 || got[0] != "crashloop" {
		t.Fatalf("after delete: %v", got)
	}
}

func TestAlertsTellEachOOMKill(t *testing.T) {
	d := newAlertDetector()
	base := running(crashing(0))
	d.pod(oom(base, 2), false, false) // an old OOM kill, seen at sync
	if got := d.pod(oom(base, 2), false, true); len(got) != 0 {
		t.Fatalf("old kill told: %v", got)
	}
	got := d.pod(oom(base, 3), false, true)
	if len(got) != 1 || got[0].Kind != "oomkilled" || !strings.Contains(got[0].Detail, "512Mi") {
		t.Fatalf("new kill: %+v", got)
	}
	if got := d.pod(oom(base, 3), false, true); len(got) != 0 {
		t.Fatalf("same kill told twice: %v", got)
	}
}

func TestAlertsTellAStuckRollout(t *testing.T) {
	d := newAlertDetector()
	dep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "checkout-api", Namespace: "payments", Annotations: map[string]string{"deployment.kubernetes.io/revision": "42"}}}
	stuck := dep.DeepCopy()
	stuck.Status.Conditions = []appsv1.DeploymentCondition{{Type: appsv1.DeploymentProgressing, Status: corev1.ConditionFalse, Reason: "ProgressDeadlineExceeded", Message: `ReplicaSet "checkout-api-7d9" has timed out progressing.`}}
	if got := d.deployment(dep, false, true); len(got) != 0 {
		t.Fatalf("healthy: %v", got)
	}
	got := d.deployment(stuck, false, true)
	if len(got) != 1 || got[0].Title != "Rollout stuck · checkout-api rev 42" || !strings.Contains(got[0].Detail, "timed out progressing") {
		t.Fatalf("stuck: %+v", got)
	}
	if got := d.deployment(stuck, false, true); len(got) != 0 {
		t.Fatalf("told twice: %v", got)
	}
	d.deployment(dep, false, true) // progressing again
	if got := d.deployment(stuck, false, true); len(got) != 1 {
		t.Fatalf("stuck again: %v", got)
	}
}

// Only the picked namespaces and kinds; at most alertBurst a window, then one grouped notice.
func TestNotifierFiltersAndGroups(t *testing.T) {
	defer func(b int, w time.Duration) { alertBurst, alertWindow = b, w }(alertBurst, alertWindow)
	alertBurst, alertWindow = 2, 150*time.Millisecond
	var mu sync.Mutex
	var got []Alert
	settings := defaultNotifySettings()
	settings.Enabled, settings.Scopes = true, map[string][]string{"prod": {"payments"}}
	settings.OOMKilled = false
	n := &notifier{sent: map[string][]time.Time{}, suppressed: map[string]int{}, settings: func() NotifySettings { return settings }, sink: func(a Alert) {
		mu.Lock()
		got = append(got, a)
		mu.Unlock()
	}}
	n.deliver(Alert{Kind: "crashloop", Cluster: "prod", Namespace: "ledger", Object: "x"})   // not picked
	n.deliver(Alert{Kind: "oomkilled", Cluster: "prod", Namespace: "payments", Object: "x"}) // kind off
	for i := range 5 {
		n.deliver(Alert{Kind: "crashloop", Cluster: "prod", Namespace: "payments", Object: string(rune('a' + i))})
	}
	mu.Lock()
	if len(got) != 2 {
		t.Fatalf("sent %d: %+v", len(got), got)
	}
	mu.Unlock()
	waitFor(t, "grouped notice", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(got) == 3 && got[2].Kind == "grouped" && strings.HasPrefix(got[2].Title, "3 more objects in trouble on prod")
	})
	if l := n.list(); len(l) != 3 || l[0].Kind != "grouped" {
		t.Fatalf("recent = %+v", l)
	}
	settings.Enabled = false
	n.deliver(Alert{Kind: "crashloop", Cluster: "prod", Namespace: "payments", Object: "z"})
	if len(n.list()) != 3 {
		t.Fatal("notifications off must send nothing")
	}
}

func TestNotificationSettingsAreSaved(t *testing.T) {
	c, _, _ := newFakeConn(t)
	m := managerWith(c, false)
	path := filepath.Join(t.TempDir(), "contexts.json")
	m.store, _ = OpenStore(path)
	if s := m.NotificationSettings(); s.Enabled || !s.CrashLoop || !s.OOMKilled || !s.Rollout {
		t.Fatalf("defaults = %+v", s)
	}
	if err := m.SetNotificationSettings(NotifySettings{Enabled: true, CrashLoop: true, Scopes: map[string][]string{"prod": {" payments ", "ledger", "payments", ""}, "dev": {""}}}); err != nil {
		t.Fatal(err)
	}
	again, _ := OpenStore(path)
	s := again.NotifySettings()
	if !s.Enabled || s.OOMKilled || len(s.Scopes) != 1 || strings.Join(s.Scopes["prod"], ",") != "ledger,payments" {
		t.Fatalf("saved = %+v", s)
	}
}

// Through a connection: a pod crashing at connect is not news; one that
// starts crashing afterwards is.
func TestConnectionSendsAlertsAfterSync(t *testing.T) {
	t.Run("watch", func(t *testing.T) { connectionAlerts(t) })
	t.Run("poll", func(t *testing.T) {
		old := pollEvery
		pollMode.Store(true)
		pollEvery = 50 * time.Millisecond
		t.Cleanup(func() { pollMode.Store(false); pollEvery = old })
		connectionAlerts(t)
	})
}

func connectionAlerts(t *testing.T) {
	old := crashing(3)
	healthy := running(crashing(0))
	healthy.Name = "api-2"
	c, client, _ := newFakeConn(t, old, healthy)
	var mu sync.Mutex
	var got []Alert
	c.onAlert = func(a Alert) {
		mu.Lock()
		got = append(got, a)
		mu.Unlock()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := c.start(ctx, "tester", false); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "synced", c.synced)
	now := crashing(1)
	now.Name = "api-2"
	now.ResourceVersion = "2" // the fake does not bump it; poll mode compares it, like the API server's
	if _, err := client.CoreV1().Pods("payments").UpdateStatus(context.Background(), now, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "alert", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(got) == 1
	})
	mu.Lock()
	defer mu.Unlock()
	if got[0].Kind != "crashloop" || got[0].Object != "api-2" || got[0].Cluster != "test" {
		t.Fatalf("alerts = %+v", got)
	}
}
