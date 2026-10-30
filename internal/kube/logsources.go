package kube

import (
	"context"
	"fmt"
	"sort"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
)

const defaultMaxLogPods = 30

// logMembershipInterval is how often selector sources are matched again for pods that came or went.
var logMembershipInterval = 3 * time.Second

// LogSourceSpec is one source of a log stream: a workload ("Deployment/api",
// "apps/StatefulSet/db"), a label selector, or fixed pods, in one namespace.
type LogSourceSpec struct {
	Namespace string   `json:"namespace"`
	Workload  string   `json:"workload,omitempty"`
	Selector  string   `json:"selector,omitempty"`
	Pods      []string `json:"pods,omitempty"`
}

// LogPod is a pod a log stream follows or followed.
type LogPod struct {
	Namespace string `json:"namespace"`
	Pod       string `json:"pod"`
	// State: following · left.
	State    string `json:"state"`
	Joined   string `json:"joined,omitempty"`
	Left     string `json:"left,omitempty"`
	Reason   string `json:"reason,omitempty"`
	Revision string `json:"revision,omitempty"`
	// Initial: present when the stream started (no "joined" marker).
	Initial bool `json:"initial"`
}

type followedPod struct {
	info   LogPod
	cancel context.CancelFunc
	seq    int
}

func podKey(ns, name string) string { return ns + "/" + name }

func (ls *logStream) podList() []LogPod {
	ps := make([]*followedPod, 0, len(ls.pods))
	for _, p := range ls.pods {
		ps = append(ps, p)
	}
	sort.Slice(ps, func(i, j int) bool { return ps[i].seq < ps[j].seq })
	out := make([]LogPod, len(ps))
	for i, p := range ps {
		out[i] = p.info
	}
	return out
}

// left marks a pod as no longer followed, once, with an inline marker.
func (ls *logStream) left(ns, pod, reason string) {
	ls.mu.Lock()
	p := ls.pods[podKey(ns, pod)]
	if p == nil || p.info.State == "left" {
		ls.mu.Unlock()
		return
	}
	now := time.Now()
	p.info.State, p.info.Left, p.info.Reason = "left", now.UTC().Format(time.RFC3339), reason
	ls.podsDirty = true
	cancel := p.cancel
	ls.mu.Unlock()
	ls.add(LogLine{Namespace: ns, Pod: pod, TS: now.Format("15:04:05.000"), Msg: fmt.Sprintf("%s left · %s", pod, reason), Event: "left"})
	if cancel != nil {
		cancel()
	}
}

func podRevision(p *corev1.Pod) string {
	if h := p.Labels["pod-template-hash"]; h != "" {
		return h
	}
	return p.Labels["controller-revision-hash"]
}

// resolvedSource is a spec with its workload turned into a selector.
type resolvedSource struct {
	spec     LogSourceSpec
	selector labels.Selector
	err      error
}

// workloadSelector reads the pod selector of a workload: "Deployment/name",
// "apps/Deployment/name", StatefulSet, DaemonSet, ReplicaSet or Job.
func (m *Manager) workloadSelector(ctx context.Context, c *clusterConn, ns, workload string) (labels.Selector, error) {
	kind, name := workload, ""
	if i := lastSlash(workload); i >= 0 {
		kind, name = workload[:i], workload[i+1:]
	}
	kind = kindLabel(kind)
	var sel *metav1.LabelSelector
	switch kind {
	case "Deployment":
		o, err := c.client.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, err
		}
		sel = o.Spec.Selector
	case "StatefulSet":
		o, err := c.client.AppsV1().StatefulSets(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, err
		}
		sel = o.Spec.Selector
	case "DaemonSet":
		o, err := c.client.AppsV1().DaemonSets(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, err
		}
		sel = o.Spec.Selector
	case "ReplicaSet":
		o, err := c.client.AppsV1().ReplicaSets(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, err
		}
		sel = o.Spec.Selector
	case "Job":
		o, err := c.client.BatchV1().Jobs(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, err
		}
		sel = o.Spec.Selector
	default:
		return nil, fmt.Errorf("logs of a %s are not supported; use a label selector", kind)
	}
	if sel == nil {
		return nil, fmt.Errorf("%s has no pod selector", workload)
	}
	return metav1.LabelSelectorAsSelector(sel)
}

func lastSlash(s string) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '/' {
			return i
		}
	}
	return -1
}

// matchPods lists a source's pods: from the pod informer when it covers the
// namespace, else from the API server.
func (m *Manager) matchPods(ctx context.Context, c *clusterConn, src resolvedSource) ([]*corev1.Pod, error) {
	if src.selector == nil {
		return nil, nil
	}
	ns := src.spec.Namespace
	if c.pods != nil && c.started.Load() && (c.podsNS == "" || c.podsNS == ns) {
		var pods []*corev1.Pod
		var err error
		if ns == "" {
			pods, err = c.pods.List(src.selector)
		} else {
			pods, err = c.pods.Pods(ns).List(src.selector)
		}
		if err == nil {
			return pods, nil
		}
	}
	list, err := c.client.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{LabelSelector: src.selector.String()})
	if err != nil {
		return nil, err
	}
	out := make([]*corev1.Pod, len(list.Items))
	for i := range list.Items {
		out[i] = &list.Items[i]
	}
	return out, nil
}

// followSources keeps the set of followed pods in line with the sources:
// fixed pods once, selector pods on every round, newest first up to MaxPods.
func (m *Manager) followSources(ctx context.Context, c *clusterConn, ls *logStream, req LogsRequest) {
	sources := make([]resolvedSource, len(req.Sources))
	for i, spec := range req.Sources {
		sources[i].spec = spec
		switch {
		case spec.Selector != "":
			sources[i].selector, sources[i].err = labels.Parse(spec.Selector)
		case spec.Workload != "":
			sources[i].selector, sources[i].err = m.workloadSelector(ctx, c, spec.Namespace, spec.Workload)
		}
		if err := sources[i].err; err != nil {
			ls.add(LogLine{Namespace: spec.Namespace, Msg: "cannot use source: " + err.Error(), Event: "failed"})
		}
	}

	seq := 0
	start := func(p *corev1.Pod, initial bool) {
		key := podKey(p.Namespace, p.Name)
		pctx, cancel := context.WithCancel(ctx)
		seq++
		now := time.Now()
		fp := &followedPod{cancel: cancel, seq: seq, info: LogPod{Namespace: p.Namespace, Pod: p.Name, State: "following", Joined: now.UTC().Format(time.RFC3339), Revision: podRevision(p), Initial: initial}}
		ls.mu.Lock()
		ls.pods[key] = fp
		ls.podsDirty = true
		ls.mu.Unlock()
		if !initial {
			ls.add(LogLine{Namespace: p.Namespace, Pod: p.Name, TS: now.Format("15:04:05.000"), Msg: p.Name + " joined", Event: "joined"})
		}
		for _, ct := range p.Spec.Containers {
			if len(req.Containers) > 0 && !contains(req.Containers, ct.Name) {
				continue
			}
			go m.followContainer(pctx, c, ls, req, p.Namespace, p.Name, ct.Name)
		}
	}

	// Fixed pods are read once; they leave when their streams find them gone.
	fixed := map[string]bool{}
	var fixedPods []*corev1.Pod
	for _, src := range sources {
		for _, name := range src.spec.Pods {
			pod, err := c.client.CoreV1().Pods(src.spec.Namespace).Get(ctx, name, metav1.GetOptions{})
			if err != nil {
				ls.add(LogLine{Namespace: src.spec.Namespace, Pod: name, Msg: "cannot read pod: " + err.Error(), Event: "failed"})
				continue
			}
			if !fixed[podKey(pod.Namespace, pod.Name)] {
				fixed[podKey(pod.Namespace, pod.Name)] = true
				fixedPods = append(fixedPods, pod)
			}
		}
	}

	round := func(initial bool) {
		matched := map[string]*corev1.Pod{}
		for _, p := range fixedPods {
			matched[podKey(p.Namespace, p.Name)] = p
		}
		failed := false
		for _, src := range sources {
			if src.err != nil {
				continue
			}
			pods, err := m.matchPods(ctx, c, src)
			if err != nil {
				failed = true
				if initial {
					ls.add(LogLine{Namespace: src.spec.Namespace, Msg: "cannot list pods: " + err.Error(), Event: "failed"})
				}
				continue
			}
			for _, p := range pods {
				if p.DeletionTimestamp == nil || initial {
					matched[podKey(p.Namespace, p.Name)] = p
				}
			}
		}
		ordered := make([]*corev1.Pod, 0, len(matched))
		for _, p := range matched {
			ordered = append(ordered, p)
		}
		// Fixed pods first, then newest first; the cap keeps the newest.
		sort.Slice(ordered, func(i, j int) bool {
			fi, fj := fixed[podKey(ordered[i].Namespace, ordered[i].Name)], fixed[podKey(ordered[j].Namespace, ordered[j].Name)]
			if fi != fj {
				return fi
			}
			return ordered[i].CreationTimestamp.After(ordered[j].CreationTimestamp.Time)
		})
		keep := ordered
		if len(keep) > req.MaxPods {
			keep = keep[:req.MaxPods]
		}
		ls.mu.Lock()
		if ls.matched != len(ordered) || ls.skipped != len(ordered)-len(keep) {
			ls.matched, ls.skipped = len(ordered), len(ordered)-len(keep)
			ls.podsDirty = true
		}
		var gone []LogPod
		if !failed {
			for key, fp := range ls.pods {
				if fp.info.State == "left" || fixed[key] {
					continue
				}
				if _, ok := matched[key]; !ok {
					gone = append(gone, fp.info)
				}
			}
		}
		var fresh []*corev1.Pod
		for _, p := range keep {
			if _, ok := ls.pods[podKey(p.Namespace, p.Name)]; !ok {
				fresh = append(fresh, p)
			}
		}
		ls.mu.Unlock()
		for _, g := range gone {
			ls.left(g.Namespace, g.Pod, "no longer matches")
		}
		if req.Previous && !initial {
			return
		}
		if !initial && !req.FollowNew {
			return
		}
		// Fixed pods first, then oldest first, so markers read in the order the pods appeared.
		for _, p := range fresh {
			if fixed[podKey(p.Namespace, p.Name)] {
				start(p, initial)
			}
		}
		for i := len(fresh) - 1; i >= 0; i-- {
			if !fixed[podKey(fresh[i].Namespace, fresh[i].Name)] {
				start(fresh[i], initial)
			}
		}
	}

	round(true)
	if req.Previous {
		return
	}
	hasSelector := false
	for _, src := range sources {
		hasSelector = hasSelector || src.selector != nil
	}
	if !hasSelector {
		return
	}
	t := time.NewTicker(logMembershipInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			round(false)
		}
	}
}
