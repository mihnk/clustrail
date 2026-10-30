package kube

import (
	"fmt"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
)

type Problem struct {
	Title     string `json:"title"`
	Container string `json:"container"`
	Detail    string `json:"detail"`
}

type ContainerStatus struct {
	Name      string `json:"name"`
	Health    Health `json:"health"`
	State     string `json:"state"`
	Ready     bool   `json:"ready"`
	Restarts  int32  `json:"restarts"`
	Image     string `json:"image,omitempty"`
	LastState string `json:"lastState,omitempty"`
	Memory    string `json:"memory,omitempty"`
}

type ResourceEvent struct {
	Type     string `json:"type"`
	Reason   string `json:"reason"`
	Message  string `json:"message"`
	Count    int32  `json:"count"`
	LastSeen string `json:"lastSeen"`
	Object   string `json:"object"`
}

type MetricSeries struct {
	Source     string    `json:"source"`
	Timestamps []int64   `json:"timestamps"`
	Values     []float64 `json:"values"`
	Limit      *float64  `json:"limit,omitempty"`
	Request    *float64  `json:"request,omitempty"`
	Markers    []int64   `json:"markers,omitempty"`
}

type MemorySeries struct {
	Container string       `json:"container"`
	Series    MetricSeries `json:"series"`
}

type OwnerLink struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
	Note string `json:"note"`
	Tone Health `json:"tone,omitempty"`
}

type RelationObject struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

type Pill struct {
	Text string `json:"text"`
	Tone string `json:"tone"`
}

type PodRelation struct {
	Label   string           `json:"label"`
	Objects []RelationObject `json:"objects"`
	Pill    *Pill            `json:"pill,omitempty"`
	Via     string           `json:"via"`
}

type PodDetail struct {
	Pod        PodRow            `json:"pod"`
	Problem    *Problem          `json:"problem"`
	Containers []ContainerStatus `json:"containers"`
	Events     []ResourceEvent   `json:"events"`
	Memory     *MemorySeries     `json:"memory"`
	OwnerChain []OwnerLink       `json:"ownerChain"`
	Relations  []PodRelation     `json:"relations"`
}

func containerState(cs corev1.ContainerStatus) (Health, string) {
	switch {
	case cs.State.Waiting != nil:
		h := Progressing
		if isFailingWaitReason(cs.State.Waiting.Reason) {
			h = Failed
		}
		return h, "Waiting · " + cs.State.Waiting.Reason
	case cs.State.Terminated != nil:
		t := cs.State.Terminated
		if t.ExitCode == 0 {
			return Completed, "Terminated · " + orDefault(t.Reason, "Completed")
		}
		return Failed, fmt.Sprintf("Terminated · %s · exit %d", orDefault(t.Reason, "Error"), t.ExitCode)
	case cs.State.Running != nil && cs.Ready:
		return Healthy, "Running · ready"
	case cs.State.Running != nil:
		return Warning, "Running · not ready"
	}
	return Unknown, "Unknown"
}

// GetPodDetail builds the inspector content for one pod: container states,
// recent events, owner chain and how related objects were found.
func (m *Manager) GetPodDetail(cluster, ns, name string) (PodDetail, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return PodDetail{}, err
	}
	if c.pods == nil {
		return PodDetail{}, fmt.Errorf("pods are not readable on %s", cluster)
	}
	p, err := c.pods.Pods(ns).Get(name)
	if err != nil {
		return PodDetail{}, err
	}
	now := time.Now()
	d := PodDetail{Pod: c.podRow(p, c.env(), now), Containers: []ContainerStatus{}, Events: []ResourceEvent{}, OwnerChain: []OwnerLink{}, Relations: []PodRelation{}}

	specs := map[string]corev1.Container{}
	for _, ct := range p.Spec.Containers {
		specs[ct.Name] = ct
	}
	var oomAt []int64
	for _, cs := range p.Status.ContainerStatuses {
		h, state := containerState(cs)
		st := ContainerStatus{Name: cs.Name, Health: h, State: state, Ready: cs.Ready, Restarts: cs.RestartCount, Image: cs.Image}
		if lt := cs.LastTerminationState.Terminated; lt != nil {
			st.LastState = fmt.Sprintf("Terminated · %s · exit %d", orDefault(lt.Reason, "Error"), lt.ExitCode)
			if lt.Reason == "OOMKilled" {
				oomAt = append(oomAt, lt.FinishedAt.Unix())
			}
		}
		if spec, ok := specs[cs.Name]; ok {
			var parts []string
			if q, ok := spec.Resources.Requests[corev1.ResourceMemory]; ok {
				parts = append(parts, "req "+q.String())
			}
			if q, ok := spec.Resources.Limits[corev1.ResourceMemory]; ok {
				parts = append(parts, "limit "+q.String())
			}
			st.Memory = strings.Join(parts, " · ")
		}
		d.Containers = append(d.Containers, st)
		if d.Problem == nil && h == Failed {
			detail := fmt.Sprintf("%d restarts", cs.RestartCount)
			if lt := cs.LastTerminationState.Terminated; lt != nil {
				detail = fmt.Sprintf("Last terminated %s (exit %d) %s ago · %d restarts", orDefault(lt.Reason, "Error"), lt.ExitCode, ago(now.Sub(lt.FinishedAt.Time)), cs.RestartCount)
			}
			title := state
			if cs.State.Waiting != nil {
				title = cs.State.Waiting.Reason
			}
			d.Problem = &Problem{Title: title, Container: cs.Name, Detail: detail}
		}
	}
	if d.Problem == nil && (d.Pod.Health == Progressing || d.Pod.Health == Warning) {
		d.Problem = &Problem{Title: d.Pod.Status, Container: "", Detail: d.Pod.Reason}
	}

	// Memory samples Clustrail collected since it connected (metrics-server keeps no history).
	for _, cs := range d.Containers {
		ts, vals := c.samples.series(ns + "/" + name + "/" + cs.Name)
		if len(ts) < 2 {
			continue
		}
		series := MetricSeries{Source: "sampled from metrics-server · 15s · since Clustrail connected", Timestamps: ts, Values: vals, Markers: oomAt}
		if spec, ok := specs[cs.Name]; ok {
			if q, ok := spec.Resources.Limits[corev1.ResourceMemory]; ok {
				series.Limit = ptr(float64(q.Value()) / (1024 * 1024))
			}
			if q, ok := spec.Resources.Requests[corev1.ResourceMemory]; ok {
				series.Request = ptr(float64(q.Value()) / (1024 * 1024))
			}
		}
		if d.Memory == nil || (d.Problem != nil && d.Problem.Container == cs.Name) {
			d.Memory = &MemorySeries{Container: cs.Name, Series: series}
		}
	}

	ctx, cancel := actionCtx()
	defer cancel()
	// Events: the pod's own, newest first. The API server keeps them about an hour by default.
	if evs, err := c.client.CoreV1().Events(ns).List(ctx, metav1.ListOptions{FieldSelector: "involvedObject.name=" + name}); err == nil {
		sort.Slice(evs.Items, func(i, j int) bool { return lastSeen(evs.Items[i]).After(lastSeen(evs.Items[j])) })
		for _, e := range evs.Items {
			d.Events = append(d.Events, ResourceEvent{
				Type: e.Type, Reason: e.Reason, Message: e.Message, Count: max(e.Count, 1),
				LastSeen: ago(now.Sub(lastSeen(e))), Object: "pod",
			})
		}
	}

	// Owner chain: ReplicaSet → Deployment.
	var relOwned []RelationObject
	if ref := metav1.GetControllerOf(p); ref != nil {
		if ref.Kind == "ReplicaSet" && c.rsets != nil {
			if rs, err := c.rsets.ReplicaSets(ns).Get(ref.Name); err == nil {
				if dref := metav1.GetControllerOf(rs); dref != nil && dref.Kind == "Deployment" {
					link := OwnerLink{Kind: "Deployment", Name: dref.Name}
					if c.deploys != nil {
						if dep, err := c.deploys.Deployments(ns).Get(dref.Name); err == nil {
							want := int32(1)
							if dep.Spec.Replicas != nil {
								want = *dep.Spec.Replicas
							}
							link.Note = fmt.Sprintf("%d/%d ready", dep.Status.ReadyReplicas, want)
							if dep.Status.ReadyReplicas < want {
								link.Tone = Warning
							}
						}
					}
					d.OwnerChain = append(d.OwnerChain, link)
					relOwned = append(relOwned, RelationObject{Kind: "deploy", Name: dref.Name})
				}
				d.OwnerChain = append(d.OwnerChain, OwnerLink{Kind: "ReplicaSet", Name: rs.Name, Note: fmt.Sprintf("rev %d", revisionOf(rs))})
				relOwned = append(relOwned, RelationObject{Kind: "rs", Name: rs.Name})
			}
		} else {
			d.OwnerChain = append(d.OwnerChain, OwnerLink{Kind: ref.Kind, Name: ref.Name})
			relOwned = append(relOwned, RelationObject{Kind: strings.ToLower(ref.Kind), Name: ref.Name})
		}
	}
	if len(relOwned) > 0 {
		d.Relations = append(d.Relations, PodRelation{Label: "Owned by", Objects: relOwned, Via: "ownerReferences"})
	}

	// Services whose selector matches the pod's labels.
	if svcs, err := c.client.CoreV1().Services(ns).List(ctx, metav1.ListOptions{}); err == nil {
		var objs []RelationObject
		var via string
		for _, s := range svcs.Items {
			if len(s.Spec.Selector) == 0 {
				continue
			}
			if labels.SelectorFromSet(s.Spec.Selector).Matches(labels.Set(p.Labels)) {
				objs = append(objs, RelationObject{Kind: "svc", Name: s.Name})
				via = "Service selector " + labels.SelectorFromSet(s.Spec.Selector).String()
			}
		}
		if len(objs) > 0 {
			rel := PodRelation{Label: "Selected by", Objects: objs, Via: via}
			if !podReady(p) {
				rel.Pill = &Pill{Text: "not ready", Tone: "warning"}
			}
			d.Relations = append(d.Relations, rel)
		}
	}

	// ConfigMaps and Secrets referenced by volumes and env (names only; Secret values are never read).
	var uses []RelationObject
	seen := map[string]bool{}
	use := func(kind, n string) {
		if n != "" && !seen[kind+n] {
			seen[kind+n] = true
			uses = append(uses, RelationObject{Kind: kind, Name: n})
		}
	}
	for _, v := range p.Spec.Volumes {
		if v.ConfigMap != nil {
			use("cm", v.ConfigMap.Name)
		}
		if v.Secret != nil {
			use("secret", v.Secret.SecretName)
		}
		if v.PersistentVolumeClaim != nil {
			use("pvc", v.PersistentVolumeClaim.ClaimName)
		}
	}
	for _, ct := range p.Spec.Containers {
		for _, ef := range ct.EnvFrom {
			if ef.ConfigMapRef != nil {
				use("cm", ef.ConfigMapRef.Name)
			}
			if ef.SecretRef != nil {
				use("secret", ef.SecretRef.Name)
			}
		}
		for _, e := range ct.Env {
			if e.ValueFrom != nil && e.ValueFrom.ConfigMapKeyRef != nil {
				use("cm", e.ValueFrom.ConfigMapKeyRef.Name)
			}
			if e.ValueFrom != nil && e.ValueFrom.SecretKeyRef != nil {
				use("secret", e.ValueFrom.SecretKeyRef.Name)
			}
		}
	}
	if len(uses) > 0 {
		d.Relations = append(d.Relations, PodRelation{Label: "Uses", Objects: uses, Via: "volumes and env references"})
	}
	if p.Spec.NodeName != "" {
		d.Relations = append(d.Relations, PodRelation{Label: "Runs on", Objects: []RelationObject{{Kind: "node", Name: strings.SplitN(p.Spec.NodeName, ".", 2)[0]}}, Via: "spec.nodeName"})
	}

	// PodDisruptionBudgets selecting the pod.
	if pdbs, err := c.client.PolicyV1().PodDisruptionBudgets(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for _, pdb := range pdbs.Items {
			if pdbMatches(&pdb, p) {
				rel := PodRelation{Label: "Disruption", Objects: []RelationObject{{Kind: "pdb", Name: pdb.Name}}, Via: "PDB selector"}
				rel.Pill = &Pill{Text: fmt.Sprintf("%d allowed", pdb.Status.DisruptionsAllowed), Tone: "info"}
				if pdb.Status.DisruptionsAllowed == 0 {
					rel.Pill.Tone = "warning"
				}
				d.Relations = append(d.Relations, rel)
			}
		}
	}
	if inst := p.Labels["app.kubernetes.io/instance"]; inst != "" {
		if lbl := p.Labels["argocd.argoproj.io/instance"]; lbl != "" {
			d.Relations = append(d.Relations, PodRelation{Label: "Managed by", Objects: []RelationObject{{Kind: "argocd", Name: lbl}}, Via: "label argocd.argoproj.io/instance"})
		}
	}
	return d, nil
}

func lastSeen(e corev1.Event) time.Time {
	switch {
	case !e.LastTimestamp.IsZero():
		return e.LastTimestamp.Time
	case e.Series != nil:
		return e.Series.LastObservedTime.Time
	case !e.EventTime.IsZero():
		return e.EventTime.Time
	}
	return e.CreationTimestamp.Time
}

func podReady(p *corev1.Pod) bool {
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

func pdbMatches(pdb *policyv1.PodDisruptionBudget, p *corev1.Pod) bool {
	if pdb.Spec.Selector == nil {
		return false
	}
	sel, err := metav1.LabelSelectorAsSelector(pdb.Spec.Selector)
	return err == nil && !sel.Empty() && sel.Matches(labels.Set(p.Labels))
}

// EventsFor lists recent events of any object, newest first.
func (m *Manager) EventsFor(cluster, ns, kind, name string) ([]ResourceEvent, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return nil, err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	sel := "involvedObject.name=" + name
	if kind != "" {
		sel += ",involvedObject.kind=" + kind
	}
	evs, err := c.client.CoreV1().Events(ns).List(ctx, metav1.ListOptions{FieldSelector: sel})
	if err != nil {
		return nil, err
	}
	now := time.Now()
	sort.Slice(evs.Items, func(i, j int) bool { return lastSeen(evs.Items[i]).After(lastSeen(evs.Items[j])) })
	out := []ResourceEvent{}
	for _, e := range evs.Items {
		out = append(out, ResourceEvent{Type: e.Type, Reason: e.Reason, Message: e.Message, Count: max(e.Count, 1), LastSeen: ago(now.Sub(lastSeen(e))), Object: strings.ToLower(e.InvolvedObject.Kind)})
	}
	return out, nil
}
