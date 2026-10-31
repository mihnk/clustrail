package kube

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/tools/cache"
)

type Drift struct {
	Resource string `json:"resource"`
	Field    string `json:"field"`
	Desired  string `json:"desired"`
	Live     string `json:"live"`
	Manager  string `json:"manager"`
	Ago      string `json:"ago"`
}

type GitOpsResource struct {
	Kind   string `json:"kind"`
	Name   string `json:"name"`
	Status string `json:"status"`
	Health string `json:"health"`
}

type GitOpsCondition struct {
	Type    string `json:"type"`
	Message string `json:"message"`
	At      string `json:"at"`
}

type GitOpsHistory struct {
	Revision string `json:"revision"`
	At       string `json:"at"`
	Message  string `json:"message"`
}

type GitOpsPolicy struct {
	Automated bool `json:"automated"`
	SelfHeal  bool `json:"selfHeal"`
	Prune     bool `json:"prune"`
}

type GitOpsObject struct {
	ID                string            `json:"id"`
	Name              string            `json:"name"`
	Kind              string            `json:"kind"`
	Tool              string            `json:"tool"`
	Namespace         string            `json:"namespace"`
	Destination       string            `json:"destination"`
	Cluster           string            `json:"cluster"`
	Env               Environment       `json:"env"`
	Sync              string            `json:"sync"`
	AppHealth         string            `json:"appHealth"`
	Health            Health            `json:"health"`
	Repo              string            `json:"repo"`
	Path              string            `json:"path"`
	Target            string            `json:"target"`
	Revision          string            `json:"revision"`
	ReconciledSeconds int64             `json:"reconciledSeconds"`
	Policy            GitOpsPolicy      `json:"policy"`
	Drift             []Drift           `json:"drift"`
	Resources         []GitOpsResource  `json:"resources"`
	Conditions        []GitOpsCondition `json:"conditions"`
	History           []GitOpsHistory   `json:"history"`
	Error             string            `json:"error,omitempty"`
	Suspended         bool              `json:"suspended,omitempty"`
}

// Controller is the GitOps tool detected on a cluster (from served CRDs).
type Controller struct {
	Cluster string      `json:"cluster"`
	Env     Environment `json:"env"`
	Tool    *string     `json:"tool"`
	Version string      `json:"version,omitempty"`
	URL     string      `json:"url,omitempty"`
}

var (
	argoApps        = schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "applications"}
	fluxKustomize   = schema.GroupVersionResource{Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Resource: "kustomizations"}
	fluxHelmRelease = schema.GroupVersionResource{Group: "helm.toolkit.fluxcd.io", Version: "v2", Resource: "helmreleases"}
)

func gitopsHealth(sync, app string) Health {
	switch {
	case sync == "Failed" || app == "Degraded" || app == "Not ready" || app == "Missing":
		return Failed
	case sync == "OutOfSync":
		return Warning
	case app == "Progressing":
		return Progressing
	case app == "Suspended":
		return Paused
	case sync == "Unknown":
		return Unknown
	}
	return Healthy
}

type gitopsWatcher struct {
	c       *clusterConn
	mu      sync.Mutex
	listers map[schema.GroupVersionResource]cache.GenericLister
	synced  []cache.InformerSynced
	dirty   bool
	sentAll bool
	tool    string
}

func newGitOpsWatcher(c *clusterConn) *gitopsWatcher {
	return &gitopsWatcher{c: c, listers: map[schema.GroupVersionResource]cache.GenericLister{}}
}

// served reports whether the API server serves a resource (the CRD exists).
func (g *gitopsWatcher) served(gvr schema.GroupVersionResource) bool {
	list, err := g.c.disc.ServerResourcesForGroupVersion(gvr.GroupVersion().String())
	if err != nil {
		return false
	}
	for _, r := range list.APIResources {
		if r.Name == gvr.Resource {
			return true
		}
	}
	return false
}

func (g *gitopsWatcher) start(ctx context.Context) {
	f := dynamicinformer.NewDynamicSharedInformerFactory(g.c.dynamic, 0)
	poll := pollMode.Load()
	mark := func(any) { g.mu.Lock(); g.dirty = true; g.mu.Unlock() }
	for _, gvr := range []schema.GroupVersionResource{argoApps, fluxKustomize, fluxHelmRelease} {
		if !g.served(gvr) || !g.c.canList(ctx, gvr.Group, gvr.Resource) {
			continue
		}
		if gvr == argoApps {
			g.tool = "Argo CD"
		} else if g.tool == "" {
			g.tool = "Flux"
		}
		if poll {
			// Poll mode: Applications and Kustomizations/HelmReleases are listed every pollEvery.
			gvr := gvr
			idx, synced := g.c.pollSource(ctx, func(ctx context.Context) ([]any, error) {
				l, err := g.c.dynamic.Resource(gvr).List(ctx, metav1.ListOptions{})
				return items(l, err, func() []unstructured.Unstructured { return l.Items })
			}, nil, mark)
			g.listers[gvr] = cache.NewGenericLister(idx, gvr.GroupResource())
			g.synced = append(g.synced, synced)
			continue
		}
		inf := f.ForResource(gvr)
		g.listers[gvr] = inf.Lister()
		g.synced = append(g.synced, inf.Informer().HasSynced)
		_, _ = inf.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{AddFunc: mark, UpdateFunc: func(_, o any) { mark(o) }, DeleteFunc: mark})
	}
	if len(g.listers) == 0 {
		return
	}
	f.Start(ctx.Done())
	safeLoop(ctx, "GitOps updates", nil, func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				f.Shutdown()
				return
			case <-t.C:
				wake("GitOps flush")
				g.flush()
			}
		}
	})
}

// controller describes the GitOps controller found. The environment is passed
// in: the manager calls this while holding its lock, and c.env() takes it too.
func (g *gitopsWatcher) controller(env Environment) Controller {
	ctl := Controller{Cluster: g.c.id, Env: env}
	if g.tool != "" {
		ctl.Tool = ptr(g.tool)
	}
	return ctl
}

func (g *gitopsWatcher) flush() {
	for _, s := range g.synced {
		if !s() {
			return
		}
	}
	g.mu.Lock()
	if !g.dirty && g.sentAll {
		g.mu.Unlock()
		return
	}
	g.dirty, g.sentAll = false, true
	g.mu.Unlock()
	g.c.emit.Emit(EventDelta, Delta{Cluster: g.c.id, Kind: "gitops", Reset: true, Upserts: toAny(g.objects()), Deletes: []string{}})
}

func (g *gitopsWatcher) objects() []GitOpsObject {
	now := time.Now()
	env := g.c.env()
	var out []GitOpsObject
	for gvr, l := range g.listers {
		objs, _ := l.List(labels.Everything())
		for _, o := range objs {
			u, ok := o.(*unstructured.Unstructured)
			if !ok {
				continue
			}
			var row GitOpsObject
			if gvr == argoApps {
				row = argoRow(u, now)
			} else {
				row = fluxRow(u, gvr, now)
			}
			row.Cluster, row.Env = g.c.id, env
			row.ID = g.c.id + "/" + row.Kind + "/" + row.Namespace + "/" + row.Name
			row.Health = gitopsHealth(row.Sync, row.AppHealth)
			out = append(out, row)
		}
	}
	return out
}

func str(u map[string]any, path ...string) string {
	v, _, _ := unstructured.NestedString(u, path...)
	return v
}

func boolAt(u map[string]any, path ...string) bool {
	v, _, _ := unstructured.NestedBool(u, path...)
	return v
}

func sinceTime(s string, now time.Time) int64 {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return 0
	}
	return int64(now.Sub(t).Seconds())
}

func clock(s string) string {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return s
	}
	return t.Local().Format("15:04:05")
}

func argoRow(u *unstructured.Unstructured, now time.Time) GitOpsObject {
	o := u.Object
	row := GitOpsObject{
		Name:        u.GetName(),
		Namespace:   u.GetNamespace(),
		Kind:        "Application",
		Tool:        "Argo CD",
		Destination: str(o, "spec", "destination", "namespace"),
		Sync:        orDefault(str(o, "status", "sync", "status"), "Unknown"),
		AppHealth:   orDefault(str(o, "status", "health", "status"), "Unknown"),
		Repo:        str(o, "spec", "source", "repoURL"),
		Path:        orDefault(str(o, "spec", "source", "path"), str(o, "spec", "source", "chart")),
		Target:      orDefault(str(o, "spec", "source", "targetRevision"), "HEAD"),
		Revision:    shortRev(str(o, "status", "sync", "revision")),
		Drift:       []Drift{},
		Resources:   []GitOpsResource{},
		Conditions:  []GitOpsCondition{},
		History:     []GitOpsHistory{},
	}
	if row.Repo == "" {
		// Multi-source Applications: show the first source.
		if srcs, ok, _ := unstructured.NestedSlice(o, "spec", "sources"); ok && len(srcs) > 0 {
			if m, ok := srcs[0].(map[string]any); ok {
				row.Repo, row.Path = str(m, "repoURL"), orDefault(str(m, "path"), str(m, "chart"))
				row.Target = orDefault(str(m, "targetRevision"), "HEAD")
			}
		}
	}
	if s := str(o, "status", "reconciledAt"); s != "" {
		row.ReconciledSeconds = sinceTime(s, now)
	}
	if _, ok, _ := unstructured.NestedMap(o, "spec", "syncPolicy", "automated"); ok {
		row.Policy.Automated = true
		row.Policy.SelfHeal = boolAt(o, "spec", "syncPolicy", "automated", "selfHeal")
		row.Policy.Prune = boolAt(o, "spec", "syncPolicy", "automated", "prune")
	}
	if phase := str(o, "status", "operationState", "phase"); phase == "Failed" || phase == "Error" {
		row.Sync = "Failed"
		row.Error = str(o, "status", "operationState", "message")
	}
	res, _, _ := unstructured.NestedSlice(o, "status", "resources")
	for _, r := range res {
		m, ok := r.(map[string]any)
		if !ok {
			continue
		}
		gr := GitOpsResource{Kind: str(m, "kind"), Name: str(m, "name"), Status: orDefault(str(m, "status"), "Unknown"), Health: orDefault(str(m, "health", "status"), "Healthy")}
		row.Resources = append(row.Resources, gr)
		if gr.Status == "OutOfSync" {
			// Argo CD's controller status names drifted resources; field-level diffs need its API server.
			row.Drift = append(row.Drift, Drift{Resource: gr.Kind + " " + gr.Name, Field: "(see Argo CD diff)", Desired: "git", Live: "cluster"})
		}
	}
	conds, _, _ := unstructured.NestedSlice(o, "status", "conditions")
	for _, c := range conds {
		if m, ok := c.(map[string]any); ok {
			row.Conditions = append(row.Conditions, GitOpsCondition{Type: str(m, "type"), Message: str(m, "message"), At: clock(str(m, "lastTransitionTime"))})
		}
	}
	hist, _, _ := unstructured.NestedSlice(o, "status", "history")
	for i := len(hist) - 1; i >= 0 && len(row.History) < 10; i-- {
		if m, ok := hist[i].(map[string]any); ok {
			rev := shortRev(str(m, "revision"))
			row.History = append(row.History, GitOpsHistory{Revision: rev, At: ago(time.Duration(sinceTime(str(m, "deployedAt"), now))*time.Second) + " ago", Message: "Sync to " + rev})
		}
	}
	return row
}

func fluxRow(u *unstructured.Unstructured, gvr schema.GroupVersionResource, now time.Time) GitOpsObject {
	o := u.Object
	kind := "Kustomization"
	if gvr == fluxHelmRelease {
		kind = "HelmRelease"
	}
	row := GitOpsObject{
		Name:       u.GetName(),
		Namespace:  u.GetNamespace(),
		Kind:       kind,
		Tool:       "Flux",
		Drift:      []Drift{},
		Resources:  []GitOpsResource{},
		Conditions: []GitOpsCondition{},
		History:    []GitOpsHistory{},
		Suspended:  boolAt(o, "spec", "suspend"),
		Policy:     GitOpsPolicy{Automated: true, Prune: boolAt(o, "spec", "prune")},
	}
	row.Destination = orDefault(str(o, "spec", "targetNamespace"), u.GetNamespace())
	if kind == "Kustomization" {
		row.Repo = str(o, "spec", "sourceRef", "kind") + "/" + str(o, "spec", "sourceRef", "name")
		row.Path = str(o, "spec", "path")
		row.Target = str(o, "spec", "interval")
		row.Revision = shortRev(str(o, "status", "lastAppliedRevision"))
	} else {
		row.Repo = str(o, "spec", "chart", "spec", "sourceRef", "kind") + "/" + str(o, "spec", "chart", "spec", "sourceRef", "name")
		row.Path = str(o, "spec", "chart", "spec", "chart")
		row.Target = orDefault(str(o, "spec", "chart", "spec", "version"), "*")
		row.Revision = str(o, "status", "lastAttemptedRevision")
	}
	row.Sync, row.AppHealth = "Unknown", "Unknown"
	conds, _, _ := unstructured.NestedSlice(o, "status", "conditions")
	for _, c := range conds {
		m, ok := c.(map[string]any)
		if !ok {
			continue
		}
		t, status := str(m, "type"), str(m, "status")
		if t == "Ready" {
			row.ReconciledSeconds = sinceTime(str(m, "lastTransitionTime"), now)
			switch status {
			case "True":
				row.Sync, row.AppHealth = "Applied", "Ready"
			case "False":
				row.Sync, row.AppHealth = "Failed", "Not ready"
				row.Error = str(m, "message")
				row.Conditions = append(row.Conditions, GitOpsCondition{Type: "Ready=False", Message: str(m, "reason"), At: clock(str(m, "lastTransitionTime"))})
			default:
				row.Sync, row.AppHealth = "Unknown", "Progressing"
			}
		}
	}
	if row.Suspended {
		row.AppHealth = "Suspended"
	}
	inv, _, _ := unstructured.NestedSlice(o, "status", "inventory", "entries")
	for _, e := range inv {
		if m, ok := e.(map[string]any); ok {
			// id is "<namespace>_<name>_<group>_<kind>"
			parts := strings.Split(str(m, "id"), "_")
			if len(parts) == 4 {
				row.Resources = append(row.Resources, GitOpsResource{Kind: parts[3], Name: parts[1], Status: "Synced", Health: "Healthy"})
			}
		}
	}
	if rev := row.Revision; rev != "" {
		row.History = append(row.History, GitOpsHistory{Revision: rev, At: ago(time.Duration(row.ReconciledSeconds)*time.Second) + " ago", Message: "Applied " + rev})
	}
	return row
}

// shortRev turns "main@sha1:8c41e2f9…" or a full SHA into "8c41e2f".
func shortRev(r string) string {
	if i := strings.LastIndex(r, ":"); i >= 0 {
		r = r[i+1:]
	}
	if len(r) == 40 {
		return r[:7]
	}
	return r
}

func (g *gitopsWatcher) gvrOf(kind string) (schema.GroupVersionResource, error) {
	switch kind {
	case "Application":
		return argoApps, nil
	case "Kustomization":
		return fluxKustomize, nil
	case "HelmRelease":
		return fluxHelmRelease, nil
	}
	return schema.GroupVersionResource{}, fmt.Errorf("unknown GitOps kind %q", kind)
}

func unstructuredNested(o map[string]any, path ...string) (any, bool, error) {
	return unstructured.NestedFieldNoCopy(o, path...)
}

func unstructuredBool(o map[string]any, path ...string) (bool, bool, error) {
	return unstructured.NestedBool(o, path...)
}
