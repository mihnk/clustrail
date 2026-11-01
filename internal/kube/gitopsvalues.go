package kube

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/yaml"
)

// GitOps resources carry Helm values too: an Argo CD Application in
// spec.source(s).helm (values as YAML text, valuesObject, parameters) and a
// Flux HelmRelease in spec.values. They follow the Helm release rules: a value
// whose key looks like a credential is shown as the placeholder, and an edit
// that keeps the placeholder keeps the live value.

func isGitOpsValues(gvr schema.GroupVersionResource) bool {
	return (gvr.Group == argoApps.Group && gvr.Resource == argoApps.Resource) ||
		(gvr.Group == fluxHelmRelease.Group && gvr.Resource == fluxHelmRelease.Resource)
}

const hiddenLastApplied = "(hidden: kubectl's last-applied copy, which holds Helm values)"

// helmBlocks returns the maps that hold Helm values in obj, in a fixed order
// (Argo CD: spec.source.helm, then spec.sources[i].helm; Flux: spec), so a
// block of an edited object lines up with the same block of the live one.
func helmBlocks(obj map[string]any) []map[string]any {
	var out []map[string]any
	if src, ok, _ := unstructured.NestedFieldNoCopy(obj, "spec", "source", "helm"); ok {
		if m, ok := src.(map[string]any); ok {
			out = append(out, m)
		}
	}
	if srcs, ok, _ := unstructured.NestedFieldNoCopy(obj, "spec", "sources"); ok {
		list, _ := srcs.([]any)
		for _, s := range list {
			sm, _ := s.(map[string]any)
			if h, ok := sm["helm"].(map[string]any); ok {
				out = append(out, h)
			} else {
				out = append(out, nil) // keeps the positions aligned
			}
		}
	}
	if kind, _, _ := unstructured.NestedString(obj, "kind"); kind == "HelmRelease" {
		if spec, ok := obj["spec"].(map[string]any); ok {
			out = append(out, spec)
		}
	}
	return out
}

// maskHelmBlock hides credential-like values in one block, in place.
func maskHelmBlock(b map[string]any) {
	if b == nil {
		return
	}
	switch v := b["values"].(type) {
	case string: // Argo CD: YAML text
		if strings.TrimSpace(v) == "" {
			break
		}
		var m map[string]any
		if err := yaml.Unmarshal([]byte(v), &m); err != nil {
			b["values"] = redactedValue // unreadable: hidden whole, never shown
			break
		}
		if red := redact(m); !reflect.DeepEqual(red, any(m)) {
			out, _ := yaml.Marshal(red)
			b["values"] = string(out)
		}
	case map[string]any: // Flux
		b["values"] = redact(v)
	}
	if v, ok := b["valuesObject"].(map[string]any); ok {
		b["valuesObject"] = redact(v)
	}
	if params, ok := b["parameters"].([]any); ok {
		for _, p := range params {
			pm, _ := p.(map[string]any)
			if name, _ := pm["name"].(string); pm != nil && looksSecret(name) {
				if _, has := pm["value"]; has {
					pm["value"] = redactedValue
				}
			}
		}
	}
}

// maskGitOpsValues hides the credential-like Helm values of an Argo CD
// Application or a Flux HelmRelease, and the same values in kubectl's
// last-applied copy.
func maskGitOpsValues(obj *unstructured.Unstructured) {
	for _, b := range helmBlocks(obj.Object) {
		maskHelmBlock(b)
	}
	ann := obj.GetAnnotations()
	raw, ok := ann[lastApplied]
	if !ok {
		return
	}
	var inner map[string]any
	if err := json.Unmarshal([]byte(raw), &inner); err != nil {
		ann[lastApplied] = hiddenLastApplied
	} else {
		for _, b := range helmBlocks(inner) {
			maskHelmBlock(b)
		}
		masked, _ := json.Marshal(inner)
		ann[lastApplied] = string(masked)
	}
	obj.SetAnnotations(ann)
}

// unmaskHelmBlock puts live values back where an edit kept the placeholder.
func unmaskHelmBlock(b, live map[string]any, where string) error {
	if b == nil {
		return nil
	}
	if live == nil {
		live = map[string]any{}
	}
	switch v := b["values"].(type) {
	case string:
		if !strings.Contains(v, redactedValue) {
			break
		}
		liveText, _ := live["values"].(string)
		if strings.TrimSpace(v) == redactedValue {
			b["values"] = liveText
			break
		}
		var m, lm map[string]any
		if err := yaml.Unmarshal([]byte(v), &m); err != nil {
			return fmt.Errorf("%s.values is not valid YAML: %w", where, err)
		}
		_ = yaml.Unmarshal([]byte(liveText), &lm)
		if err := unredact(m, lm, where+".values"); err != nil {
			return err
		}
		out, _ := yaml.Marshal(m)
		b["values"] = string(out)
	case map[string]any:
		lm, _ := live["values"].(map[string]any)
		if err := unredact(v, lm, where+".values"); err != nil {
			return err
		}
	}
	if v, ok := b["valuesObject"].(map[string]any); ok {
		lm, _ := live["valuesObject"].(map[string]any)
		if err := unredact(v, lm, where+".valuesObject"); err != nil {
			return err
		}
	}
	if params, ok := b["parameters"].([]any); ok {
		liveParams, _ := live["parameters"].([]any)
		for _, p := range params {
			pm, _ := p.(map[string]any)
			if pm == nil || pm["value"] != redactedValue {
				continue
			}
			name, _ := pm["name"].(string)
			found := false
			for _, lp := range liveParams {
				lpm, _ := lp.(map[string]any)
				if ln, _ := lpm["name"].(string); ln == name {
					pm["value"], found = lpm["value"], true
					break
				}
			}
			if !found {
				return fmt.Errorf("parameter %q is hidden but not in the live object; type its value", name)
			}
		}
	}
	return nil
}

// unmaskGitOpsValues restores what the UI was never sent: hidden Helm values
// and a masked last-applied copy (put back as it is live; placeholders in it
// would break the next kubectl apply). A placeholder left with no live value
// is refused rather than sent.
func unmaskGitOpsValues(c *clusterConn, gvr schema.GroupVersionResource, namespaced bool, obj *unstructured.Unstructured) error {
	body, _ := json.Marshal(obj.Object)
	if !strings.Contains(string(body), redactedValue) && !strings.Contains(string(body), "(hidden:") {
		return nil
	}
	ctx, cancel := actionCtx()
	defer cancel()
	ri := c.dynamic.Resource(gvr)
	var live *unstructured.Unstructured
	var err error
	if namespaced {
		live, err = ri.Namespace(obj.GetNamespace()).Get(ctx, obj.GetName(), metav1.GetOptions{})
	} else {
		live, err = ri.Get(ctx, obj.GetName(), metav1.GetOptions{})
	}
	if err != nil {
		return fmt.Errorf("reading the live %s to keep its hidden values: %w", obj.GetKind(), err)
	}
	if ann := obj.GetAnnotations(); ann[lastApplied] != "" &&
		(strings.Contains(ann[lastApplied], redactedValue) || ann[lastApplied] == hiddenLastApplied) {
		if v, ok := live.GetAnnotations()[lastApplied]; ok {
			ann[lastApplied] = v
		} else {
			delete(ann, lastApplied)
		}
		obj.SetAnnotations(ann)
	}
	edited, current := helmBlocks(obj.Object), helmBlocks(live.Object)
	for i, b := range edited {
		var lb map[string]any
		if i < len(current) {
			lb = current[i]
		}
		if err := unmaskHelmBlock(b, lb, fmt.Sprintf("helm values (%d)", i+1)); err != nil {
			return err
		}
	}
	if hasPlaceholder(obj.Object) {
		return fmt.Errorf("the object still contains %q; type the real values", redactedValue)
	}
	return nil
}
