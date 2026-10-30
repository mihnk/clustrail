package kube

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/yaml"
)

// GitOpsOwner says which controller manages an object and whether it reverts edits.
type GitOpsOwner struct {
	Tool     string `json:"tool"`
	App      string `json:"app"`
	SelfHeal bool   `json:"selfHeal"`
	Source   string `json:"source"`
}

// LiveObject is an object as the API server returns it, for the YAML editor.
type LiveObject struct {
	YAML            string            `json:"yaml"`
	ResourceVersion string            `json:"resourceVersion"`
	GitOps          *GitOpsOwner      `json:"gitops,omitempty"`
	Owners          map[string]string `json:"owners"`
	APIVersion      string            `json:"apiVersion"`
	// Secret: the keys of a Secret, whose values are hidden in YAML (see secrets.go).
	Secret *SecretInfo `json:"secret,omitempty"`
}

// ApplyResult reports a server-side apply or its dry run.
type ApplyResult struct {
	DryRun          bool   `json:"dryRun"`
	ResourceVersion string `json:"resourceVersion"`
	// Conflict: the object changed since it was opened, or another field manager owns a changed field.
	Conflict string   `json:"conflict,omitempty"`
	Warnings []string `json:"warnings"`
}

type kindIndex struct {
	once       sync.Once
	byKind     map[string]schema.GroupVersionResource
	namespaced map[string]bool
	// listable is every kind (preferred version) this cluster can list, for ⌘J.
	listable []KindInfo
	err      error
}

// resolve maps a Kind (optionally "group/Kind") to a resource using discovery.
func (c *clusterConn) resolve(kind string) (schema.GroupVersionResource, bool, error) {
	c.kinds.once.Do(func() {
		c.kinds.byKind, c.kinds.namespaced = map[string]schema.GroupVersionResource{}, map[string]bool{}
		// Partial discovery failures (an unavailable aggregated API) still return the rest.
		groups, lists, err := c.disc.ServerGroupsAndResources()
		if err != nil && len(lists) == 0 {
			c.kinds.err = err
			return
		}
		preferred := map[string]string{}
		for _, g := range groups {
			preferred[g.Name] = g.PreferredVersion.Version
		}
		for _, l := range lists {
			gv, err := schema.ParseGroupVersion(l.GroupVersion)
			if err != nil {
				continue
			}
			if v, ok := preferred[gv.Group]; ok && v != "" && v != gv.Version {
				continue
			}
			for _, r := range l.APIResources {
				if strings.Contains(r.Name, "/") {
					continue
				}
				gvr := gv.WithResource(r.Name)
				if hasVerb(r.Verbs, "list") {
					c.kinds.listable = append(c.kinds.listable, KindInfo{
						Kind: r.Kind, Group: gv.Group, Version: gv.Version, Resource: r.Name,
						Namespaced: r.Namespaced, ShortNames: r.ShortNames, Delete: hasVerb(r.Verbs, "delete"),
					})
				}
				for _, key := range []string{r.Kind, gv.Group + "/" + r.Kind} {
					// Core and apps win over aggregated APIs that reuse a Kind name.
					if _, dup := c.kinds.byKind[key]; !dup || gv.Group == "" || gv.Group == "apps" {
						c.kinds.byKind[key] = gvr
						c.kinds.namespaced[key] = r.Namespaced
					}
				}
			}
		}
	})
	if c.kinds.err != nil {
		return schema.GroupVersionResource{}, false, c.kinds.err
	}
	gvr, ok := c.kinds.byKind[kind]
	if !ok {
		return gvr, false, fmt.Errorf("kind %q is not served by this cluster", kind)
	}
	return gvr, c.kinds.namespaced[kind], nil
}

// GetObject returns the live object as YAML with field ownership and GitOps owner.
func (m *Manager) GetObject(cluster, kind, ns, name string) (LiveObject, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return LiveObject{}, err
	}
	gvr, namespaced, err := c.resolve(kind)
	if err != nil {
		return LiveObject{}, err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	ri := c.dynamic.Resource(gvr)
	var obj *unstructured.Unstructured
	if namespaced {
		obj, err = ri.Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	} else {
		obj, err = ri.Get(ctx, name, metav1.GetOptions{})
	}
	if err != nil {
		return LiveObject{}, err
	}
	live := LiveObject{ResourceVersion: obj.GetResourceVersion(), Owners: ownersOf(obj), APIVersion: obj.GetAPIVersion()}
	live.GitOps = c.gitopsOwner(obj)
	// managedFields are shown as ownership; the YAML stays readable without them.
	clean := obj.DeepCopy()
	unstructured.RemoveNestedField(clean.Object, "metadata", "managedFields")
	if isSecret(gvr) {
		live.Secret = maskSecret(clean)
	}
	b, err := yaml.Marshal(clean.Object)
	if err != nil {
		return LiveObject{}, err
	}
	live.YAML = string(b)
	return live, nil
}

// ownersOf flattens managedFields (FieldsV1) into "spec.replicas" → manager,
// using "[name]" for list items keyed by name, like the editor's paths.
func ownersOf(obj *unstructured.Unstructured) map[string]string {
	out := map[string]string{}
	for _, mf := range obj.GetManagedFields() {
		if mf.Subresource != "" || mf.FieldsV1 == nil {
			continue
		}
		var tree map[string]any
		if json.Unmarshal(mf.FieldsV1.Raw, &tree) != nil {
			continue
		}
		var walk func(node map[string]any, path string)
		walk = func(node map[string]any, path string) {
			leaf := true
			for k, v := range node {
				if k == "." {
					continue
				}
				child, _ := v.(map[string]any)
				var seg string
				switch {
				case strings.HasPrefix(k, "f:"):
					seg = k[2:]
					if path != "" {
						seg = path + "." + seg
					}
				case strings.HasPrefix(k, "k:"):
					var key map[string]any
					_ = json.Unmarshal([]byte(k[2:]), &key)
					id := fmt.Sprint(key["name"])
					if key["name"] == nil {
						id = k[2:]
					}
					seg = path + "[" + id + "]"
				default:
					continue
				}
				leaf = false
				if len(child) == 0 {
					out[seg] = mf.Manager
				} else {
					walk(child, seg)
				}
			}
			if leaf && path != "" {
				out[path] = mf.Manager
			}
		}
		walk(tree, "")
	}
	for k := range out {
		if strings.HasPrefix(k, "metadata.") || strings.HasPrefix(k, "status") {
			delete(out, k)
		}
	}
	return out
}

func (c *clusterConn) gitopsOwner(obj *unstructured.Unstructured) *GitOpsOwner {
	ann, lbl := obj.GetAnnotations(), obj.GetLabels()
	if id := ann["argocd.argoproj.io/tracking-id"]; id != "" || lbl["argocd.argoproj.io/instance"] != "" {
		app := strings.SplitN(id, ":", 2)[0]
		if app == "" {
			app = lbl["argocd.argoproj.io/instance"]
		}
		o := &GitOpsOwner{Tool: "Argo CD", App: app}
		if c.gitops != nil {
			if l, ok := c.gitops.listers[argoApps]; ok {
				appNS, appName := "argocd", app
				if ns, n, ok := strings.Cut(app, "_"); ok {
					appNS, appName = ns, n
				}
				if raw, err := l.ByNamespace(appNS).Get(appName); err == nil {
					if u, ok := raw.(*unstructured.Unstructured); ok {
						o.App = appNS + "/" + appName
						o.SelfHeal = boolAt(u.Object, "spec", "syncPolicy", "automated", "selfHeal")
						o.Source = str(u.Object, "spec", "source", "repoURL") + " · " + str(u.Object, "spec", "source", "path")
					}
				}
			}
		}
		return o
	}
	if n := lbl["kustomize.toolkit.fluxcd.io/name"]; n != "" {
		return &GitOpsOwner{Tool: "Flux", App: lbl["kustomize.toolkit.fluxcd.io/namespace"] + "/" + n, SelfHeal: true, Source: "Kustomization " + n}
	}
	if n := lbl["helm.toolkit.fluxcd.io/name"]; n != "" {
		return &GitOpsOwner{Tool: "Flux", App: lbl["helm.toolkit.fluxcd.io/namespace"] + "/" + n, SelfHeal: true, Source: "HelmRelease " + n}
	}
	return nil
}

// ApplyYAML server-side applies an edited object as field manager "clustrail".
// The resourceVersion the user opened is sent along, so a concurrent change is
// a conflict instead of being overwritten. dryRun runs every admission check
// without persisting.
func (m *Manager) ApplyYAML(cluster, text, openedVersion string, dryRun, force bool) (ApplyResult, error) {
	res := ApplyResult{DryRun: dryRun, Warnings: []string{}}
	var c *clusterConn
	var err error
	if dryRun {
		c, err = m.conn(cluster)
	} else {
		c, err = m.writable(cluster)
	}
	if err != nil {
		return res, err
	}
	var obj unstructured.Unstructured
	if err := yaml.Unmarshal([]byte(text), &obj.Object); err != nil {
		return res, fmt.Errorf("invalid YAML: %w", err)
	}
	gvr, namespaced, err := c.resolve(obj.GroupVersionKind().Group + "/" + obj.GetKind())
	if err != nil {
		if gvr, namespaced, err = c.resolve(obj.GetKind()); err != nil {
			return res, err
		}
	}
	if isSecret(gvr) {
		// Hidden values were never sent to the UI: put the live ones back.
		if err := unmaskSecret(c, &obj); err != nil {
			return res, err
		}
	}
	// Server-managed fields are not part of an apply configuration.
	unstructured.RemoveNestedField(obj.Object, "metadata", "managedFields")
	unstructured.RemoveNestedField(obj.Object, "metadata", "creationTimestamp")
	unstructured.RemoveNestedField(obj.Object, "metadata", "uid")
	unstructured.RemoveNestedField(obj.Object, "metadata", "generation")
	unstructured.RemoveNestedField(obj.Object, "status")
	if openedVersion != "" {
		obj.SetResourceVersion(openedVersion)
	}
	if obj.GetName() == "" {
		return res, fmt.Errorf("metadata.name is required")
	}
	if namespaced && obj.GetNamespace() == "" {
		// Like kubectl: the context's namespace.
		ns := c.fallbackNS
		if ns == "" {
			ns = "default"
		}
		obj.SetNamespace(ns)
	}
	body, err := json.Marshal(obj.Object)
	if err != nil {
		return res, err
	}
	opts := metav1.PatchOptions{FieldManager: "clustrail", Force: &force}
	if dryRun {
		opts.DryRun = []string{metav1.DryRunAll}
	}
	ctx, cancel := actionCtx()
	defer cancel()
	ri := c.dynamic.Resource(gvr)
	var out *unstructured.Unstructured
	if namespaced {
		out, err = ri.Namespace(obj.GetNamespace()).Patch(ctx, obj.GetName(), types.ApplyPatchType, body, opts)
	} else {
		out, err = ri.Patch(ctx, obj.GetName(), types.ApplyPatchType, body, opts)
	}
	if apierrors.IsConflict(err) {
		res.Conflict = err.Error()
		return res, nil
	}
	if err != nil {
		return res, err
	}
	res.ResourceVersion = out.GetResourceVersion()
	return res, nil
}

// ListNamespaces returns namespace names the identity can see.
func (m *Manager) ListNamespaces(cluster string) ([]string, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return nil, err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	list, err := c.client.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if apierrors.IsForbidden(err) && c.fallbackNS != "" {
		// Namespace-scoped identities cannot list namespaces; offer their own.
		return []string{c.fallbackNS}, nil
	}
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(list.Items))
	for _, n := range list.Items {
		out = append(out, n.Name)
	}
	sort.Strings(out)
	return out, nil
}
