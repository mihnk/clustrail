package kube

import (
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
)

// Selective notifications: in the namespaces the user picked, tell them when
// a container keeps crashing (CrashLoopBackOff), is killed at its memory
// limit (OOMKilled), or a Deployment's rollout passes its progress deadline.
// Each is told once per object until it recovers; more than alertBurst in a
// minute on one cluster are told as one. Where it is shown (a toast in front,
// a desktop notification behind) is the app's call (AlertSink).

// EventAlert carries one Alert to the UI.
const EventAlert = "clustrail:alert"

// Alert is one piece of news.
type Alert struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"` // crashloop, oomkilled, rollout, recovered, grouped
	Cluster    string `json:"cluster"`
	Namespace  string `json:"namespace"`
	ObjectKind string `json:"objectKind"` // Pod or Deployment
	Object     string `json:"object"`
	Title      string `json:"title"`
	Detail     string `json:"detail"`
	At         int64  `json:"at"` // unix ms
}

// NotifySettings say what to tell and where. Off until namespaces are picked.
type NotifySettings struct {
	Enabled bool `json:"enabled"`
	// Scopes: cluster id → namespaces to watch.
	Scopes    map[string][]string `json:"scopes"`
	CrashLoop bool                `json:"crashLoop"`
	OOMKilled bool                `json:"oomKilled"`
	Rollout   bool                `json:"rollout"`
}

func defaultNotifySettings() NotifySettings {
	return NotifySettings{Scopes: map[string][]string{}, CrashLoop: true, OOMKilled: true, Rollout: true}
}

// alertDetector turns object changes of one connection into alerts. Before
// the caches are synced it only records what is already wrong, so a connect
// does not tell about every pod that was crashing before.
type alertDetector struct {
	mu      sync.Mutex
	active  map[string]bool  // "crashloop|ns/pod/container", "rollout|ns/deploy"
	oomSeen map[string]int32 // ns/pod/container → restart count of the last OOMKilled told
}

func newAlertDetector() *alertDetector {
	return &alertDetector{active: map[string]bool{}, oomSeen: map[string]int32{}}
}

// pod returns the alerts a pod's change brings. live: the caches are synced.
func (d *alertDetector) pod(p *corev1.Pod, deleted, live bool) []Alert {
	d.mu.Lock()
	defer d.mu.Unlock()
	base := p.Namespace + "/" + p.Name
	if deleted {
		d.forget(base)
		return nil
	}
	var out []Alert
	for _, cs := range p.Status.ContainerStatuses {
		key := base + "/" + cs.Name
		crash := cs.State.Waiting != nil && cs.State.Waiting.Reason == "CrashLoopBackOff"
		switch ck := "crashloop|" + key; {
		case crash && !d.active[ck]:
			d.active[ck] = true
			if live {
				detail := fmt.Sprintf("container %s keeps restarting (%d restarts)", cs.Name, cs.RestartCount)
				if t := cs.LastTerminationState.Terminated; t != nil {
					detail += fmt.Sprintf("; last exit %d", t.ExitCode)
					if t.Reason != "" {
						detail += " (" + t.Reason + ")"
					}
				}
				out = append(out, Alert{Kind: "crashloop", Namespace: p.Namespace, ObjectKind: "Pod", Object: p.Name, Title: "CrashLoopBackOff · " + p.Name, Detail: detail})
			}
		case !crash && d.active[ck] && cs.Ready:
			delete(d.active, ck)
			if live {
				out = append(out, Alert{Kind: "recovered", Namespace: p.Namespace, ObjectKind: "Pod", Object: p.Name, Title: "Recovered · " + p.Name, Detail: fmt.Sprintf("container %s is running again", cs.Name)})
			}
		}
		if t := cs.LastTerminationState.Terminated; t != nil && t.Reason == "OOMKilled" {
			seen, ok := d.oomSeen[key]
			if !ok || cs.RestartCount > seen {
				d.oomSeen[key] = cs.RestartCount
				if live && (ok || cs.RestartCount > 0) {
					out = append(out, Alert{Kind: "oomkilled", Namespace: p.Namespace, ObjectKind: "Pod", Object: p.Name, Title: "OOMKilled · " + p.Name,
						Detail: fmt.Sprintf("container %s was killed at its memory limit%s (%d restarts)", cs.Name, memLimit(p, cs.Name), cs.RestartCount)})
				}
			}
		}
	}
	return out
}

func memLimit(p *corev1.Pod, container string) string {
	for _, c := range p.Spec.Containers {
		if c.Name == container {
			if q, ok := c.Resources.Limits[corev1.ResourceMemory]; ok {
				return " of " + q.String()
			}
		}
	}
	return ""
}

// deployment returns the alerts a Deployment's change brings.
func (d *alertDetector) deployment(dep *appsv1.Deployment, deleted, live bool) []Alert {
	d.mu.Lock()
	defer d.mu.Unlock()
	key := "rollout|" + dep.Namespace + "/" + dep.Name
	if deleted {
		delete(d.active, key)
		return nil
	}
	var stuck *appsv1.DeploymentCondition
	for i := range dep.Status.Conditions {
		c := &dep.Status.Conditions[i]
		if c.Type == appsv1.DeploymentProgressing && c.Status == corev1.ConditionFalse && c.Reason == "ProgressDeadlineExceeded" {
			stuck = c
		}
	}
	switch {
	case stuck != nil && !d.active[key]:
		d.active[key] = true
		if live {
			rev := dep.Annotations["deployment.kubernetes.io/revision"]
			title := "Rollout stuck · " + dep.Name
			if rev != "" {
				title += " rev " + rev
			}
			return []Alert{{Kind: "rollout", Namespace: dep.Namespace, ObjectKind: "Deployment", Object: dep.Name, Title: title, Detail: "ProgressDeadlineExceeded: " + stuck.Message}}
		}
	case stuck == nil && d.active[key]:
		delete(d.active, key)
	}
	return nil
}

// forget drops the state of a deleted pod. Caller holds mu.
func (d *alertDetector) forget(base string) {
	for k := range d.active {
		if strings.HasPrefix(k, "crashloop|"+base+"/") {
			delete(d.active, k)
		}
	}
	for k := range d.oomSeen {
		if strings.HasPrefix(k, base+"/") {
			delete(d.oomSeen, k)
		}
	}
}

// alertBurst is how many alerts a cluster may send in alertWindow before the
// rest are told as one.
var (
	alertBurst  = 5
	alertWindow = time.Minute
	keepAlerts  = 50
)

// notifier filters alerts by the settings, limits the rate per cluster,
// keeps the recent ones and hands them to the sink.
type notifier struct {
	mu         sync.Mutex
	settings   func() NotifySettings
	sink       func(Alert)
	sent       map[string][]time.Time // cluster → send times in the window
	suppressed map[string]int
	recent     []Alert
	seq        int
}

func (n *notifier) wants(a Alert) bool {
	s := n.settings()
	if !s.Enabled || !slices.Contains(s.Scopes[a.Cluster], a.Namespace) {
		return false
	}
	switch a.Kind {
	case "crashloop":
		return s.CrashLoop
	case "oomkilled":
		return s.OOMKilled
	case "rollout":
		return s.Rollout
	case "recovered":
		return s.CrashLoop
	}
	return true
}

// deliver sends a (or counts it into a grouped notice when the cluster is over its rate).
func (n *notifier) deliver(a Alert) {
	if !n.wants(a) {
		return
	}
	now := time.Now()
	n.mu.Lock()
	n.seq++
	a.ID, a.At = fmt.Sprintf("alert-%d", n.seq), now.UnixMilli()
	window := n.sent[a.Cluster][:0]
	for _, t := range n.sent[a.Cluster] {
		if now.Sub(t) < alertWindow {
			window = append(window, t)
		}
	}
	if a.Kind != "recovered" && len(window) >= alertBurst {
		if n.suppressed[a.Cluster] == 0 {
			cluster := a.Cluster
			time.AfterFunc(alertWindow, func() { n.flushGrouped(cluster) })
		}
		n.suppressed[a.Cluster]++
		n.sent[a.Cluster] = window
		n.mu.Unlock()
		return
	}
	if a.Kind != "recovered" {
		window = append(window, now)
	}
	n.sent[a.Cluster] = window
	n.remember(a)
	sink := n.sink
	n.mu.Unlock()
	if sink != nil {
		sink(a)
	}
}

func (n *notifier) flushGrouped(cluster string) {
	n.mu.Lock()
	count := n.suppressed[cluster]
	delete(n.suppressed, cluster)
	if count == 0 {
		n.mu.Unlock()
		return
	}
	n.seq++
	a := Alert{ID: fmt.Sprintf("alert-%d", n.seq), Kind: "grouped", Cluster: cluster, Title: fmt.Sprintf("%d more objects in trouble on %s", count, cluster),
		Detail: "Notifications were grouped: more than " + fmt.Sprint(alertBurst) + " in a minute.", At: time.Now().UnixMilli()}
	n.remember(a)
	sink := n.sink
	n.mu.Unlock()
	if sink != nil {
		sink(a)
	}
}

// remember keeps the latest alerts. Caller holds mu.
func (n *notifier) remember(a Alert) {
	n.recent = append(n.recent, a)
	if len(n.recent) > keepAlerts {
		n.recent = n.recent[len(n.recent)-keepAlerts:]
	}
}

func (n *notifier) list() []Alert {
	n.mu.Lock()
	defer n.mu.Unlock()
	out := make([]Alert, len(n.recent))
	copy(out, n.recent)
	slices.Reverse(out) // newest first
	return out
}

// alertPod feeds a pod change to the detector. A pod no longer in the cache
// was deleted.
func (c *clusterConn) alertPod(p *corev1.Pod) {
	if c.alerts == nil || c.onAlert == nil {
		return
	}
	deleted := false
	if c.pods != nil {
		_, err := c.pods.Pods(p.Namespace).Get(p.Name)
		deleted = err != nil
	}
	for _, a := range c.alerts.pod(p, deleted, c.alertsLive()) {
		a.Cluster = c.id
		c.onAlert(a)
	}
}

func (c *clusterConn) alertDeployment(d *appsv1.Deployment) {
	if c.alerts == nil || c.onAlert == nil {
		return
	}
	deleted := false
	if c.deploys != nil {
		_, err := c.deploys.Deployments(d.Namespace).Get(d.Name)
		deleted = err != nil
	}
	for _, a := range c.alerts.deployment(d, deleted, c.alertsLive()) {
		a.Cluster = c.id
		c.onAlert(a)
	}
}

// Settings and the manager's API.

func (s *Store) NotifySettings() NotifySettings {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Notifications == nil {
		return defaultNotifySettings()
	}
	out := *s.data.Notifications
	out.Scopes = map[string][]string{}
	for k, v := range s.data.Notifications.Scopes {
		out.Scopes[k] = append([]string{}, v...)
	}
	return out
}

func (s *Store) SetNotifySettings(n NotifySettings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Notifications = &n
	return s.save()
}

// notify is the manager's notifier, made on first use.
func (m *Manager) notify() *notifier {
	m.alertsOnce.Do(func() {
		m.alertsN = &notifier{
			sent: map[string][]time.Time{}, suppressed: map[string]int{},
			settings: func() NotifySettings {
				if m.store == nil {
					return defaultNotifySettings()
				}
				return m.store.NotifySettings()
			},
			sink: func(a Alert) {
				if m.emit != nil {
					m.emit.Emit(EventAlert, a)
				}
			},
		}
	})
	return m.alertsN
}

// SetAlertSink sets where alerts go (the app: a toast in front, a desktop
// notification behind). The default sends them to the UI only.
func (m *Manager) SetAlertSink(sink func(Alert)) {
	n := m.notify()
	n.mu.Lock()
	n.sink = sink
	n.mu.Unlock()
}

// NotificationSettings returns what is told and where.
func (m *Manager) NotificationSettings() NotifySettings { return m.store.NotifySettings() }

// SetNotificationSettings stores them; namespaces are trimmed and sorted.
func (m *Manager) SetNotificationSettings(s NotifySettings) error {
	if s.Scopes == nil {
		s.Scopes = map[string][]string{}
	}
	for c, nss := range s.Scopes {
		clean := []string{}
		for _, ns := range nss {
			if ns = strings.TrimSpace(ns); ns != "" && !slices.Contains(clean, ns) {
				clean = append(clean, ns)
			}
		}
		slices.Sort(clean)
		if len(clean) == 0 {
			delete(s.Scopes, c)
		} else {
			s.Scopes[c] = clean
		}
	}
	return m.store.SetNotifySettings(s)
}

// Alerts lists the latest alerts, newest first.
func (m *Manager) Alerts() []Alert { return m.notify().list() }

// TestNotification sends a sample alert through the sink, past the filters.
func (m *Manager) TestNotification() {
	n := m.notify()
	n.mu.Lock()
	sink := n.sink
	n.mu.Unlock()
	if sink != nil {
		sink(Alert{ID: "test", Kind: "test", Title: "Clustrail notifications work", Detail: "This is how trouble in the namespaces you picked will look.", At: time.Now().UnixMilli()})
	}
}

// waitForAlerts adds a source whose first list must reach the handlers
// before alerts start.
func (c *clusterConn) waitForAlerts(ready func() bool) {
	c.alertMu.Lock()
	c.alertReady = append(c.alertReady, ready)
	c.alertMu.Unlock()
}

// alertsLive: every source's first list has reached the handlers, so a
// change from now on is news.
func (c *clusterConn) alertsLive() bool {
	c.alertMu.Lock()
	ready := c.alertReady
	c.alertMu.Unlock()
	if len(ready) == 0 {
		return false
	}
	for _, f := range ready {
		if !f() {
			return false
		}
	}
	return true
}
