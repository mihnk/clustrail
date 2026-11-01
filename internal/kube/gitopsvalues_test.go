package kube

import (
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"sigs.k8s.io/yaml"
)

func argoApp() *unstructured.Unstructured {
	applied := `{"apiVersion":"argoproj.io/v1alpha1","kind":"Application","metadata":{"name":"payments","namespace":"argocd"},"spec":{"source":{"helm":{"values":"db:\n  password: hunter2-db\n"}}}}`
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
		"metadata": map[string]any{"name": "payments", "namespace": "argocd", "annotations": map[string]any{lastApplied: applied}},
		"spec": map[string]any{
			"source": map[string]any{
				"repoURL": "https://charts.example", "chart": "payments",
				"helm": map[string]any{
					"values":       "db:\n  host: db.internal\n  password: hunter2-db\nreplicas: 3\n",
					"valuesObject": map[string]any{"auth": map[string]any{"token": "t0ken-value", "issuer": "acme"}},
					"parameters": []any{
						map[string]any{"name": "auth.apiKey", "value": "k3y-value"},
						map[string]any{"name": "image.tag", "value": "1.9.0"},
					},
				},
			},
			"sources": []any{
				map[string]any{"repoURL": "https://other.example"},
				map[string]any{"helm": map[string]any{"values": "smtp:\n  password: m4il-pass\n"}},
			},
		},
	}}
}

func fluxRelease() *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "helm.toolkit.fluxcd.io/v2", "kind": "HelmRelease",
		"metadata": map[string]any{"name": "ledger", "namespace": "payments"},
		"spec":     map[string]any{"chart": map[string]any{"spec": map[string]any{"chart": "ledger"}}, "values": map[string]any{"credentials": "fl0x-cred", "replicas": int64(2)}},
	}}
}

var gitopsSecrets = []string{"hunter2-db", "t0ken-value", "k3y-value", "m4il-pass", "fl0x-cred"}

func gitopsConn(t *testing.T) (*clusterConn, *Manager) {
	t.Helper()
	c, client, _ := newFakeConn(t)
	client.Fake.Resources = []*metav1.APIResourceList{
		{GroupVersion: "argoproj.io/v1alpha1", APIResources: []metav1.APIResource{{Name: "applications", Kind: "Application", Namespaced: true, Verbs: []string{"get", "list", "patch"}}}},
		{GroupVersion: "helm.toolkit.fluxcd.io/v2", APIResources: []metav1.APIResource{{Name: "helmreleases", Kind: "HelmRelease", Namespaced: true, Verbs: []string{"get", "list", "patch"}}}},
	}
	c.dynamic = dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		argoApps: "ApplicationList", fluxHelmRelease: "HelmReleaseList",
	}, argoApp(), fluxRelease())
	return c, managerWith(c, false)
}

// Helm values inside GitOps resources are hidden like a Helm release's.
func TestGitOpsHelmValuesAreHidden(t *testing.T) {
	_, m := gitopsConn(t)
	for _, o := range []struct{ kind, ns, name string }{{"argoproj.io/Application", "argocd", "payments"}, {"helm.toolkit.fluxcd.io/HelmRelease", "payments", "ledger"}} {
		live, err := m.GetObject("test", o.kind, o.ns, o.name)
		if err != nil {
			t.Fatal(err)
		}
		for _, v := range gitopsSecrets {
			if strings.Contains(live.YAML, v) {
				t.Fatalf("%s: %q leaked:\n%s", o.kind, v, live.YAML)
			}
		}
		if !strings.Contains(live.YAML, redactedValue) {
			t.Fatalf("%s: no placeholder:\n%s", o.kind, live.YAML)
		}
	}
	live, _ := m.GetObject("test", "argoproj.io/Application", "argocd", "payments")
	for _, keep := range []string{"db.internal", "acme", "1.9.0", "replicas: 3"} {
		if !strings.Contains(live.YAML, keep) {
			t.Fatalf("%q, not a credential, should stay visible:\n%s", keep, live.YAML)
		}
	}
}

// Applying the YAML as shown keeps every live value; a value typed over the
// placeholder is the one sent; a placeholder with nothing live behind it is refused.
func TestGitOpsHelmValuesSurviveAnEdit(t *testing.T) {
	c, m := gitopsConn(t)
	shown, err := m.GetObject("test", "argoproj.io/Application", "argocd", "payments")
	if err != nil {
		t.Fatal(err)
	}
	edited := &unstructured.Unstructured{}
	if err := yaml.Unmarshal([]byte(shown.YAML), &edited.Object); err != nil {
		t.Fatal(err)
	}
	// The user changes one parameter and leaves the rest as shown.
	params, _, _ := unstructured.NestedSlice(edited.Object, "spec", "source", "helm", "parameters")
	params[1].(map[string]any)["value"] = "2.0.0"
	_ = unstructured.SetNestedSlice(edited.Object, params, "spec", "source", "helm", "parameters")

	if err := unmaskGitOpsValues(c, argoApps, true, edited); err != nil {
		t.Fatal(err)
	}
	h, _, _ := unstructured.NestedMap(edited.Object, "spec", "source", "helm")
	var vals map[string]any
	_ = yaml.Unmarshal([]byte(h["values"].(string)), &vals)
	if vals["db"].(map[string]any)["password"] != "hunter2-db" || vals["db"].(map[string]any)["host"] != "db.internal" {
		t.Fatalf("values = %v", vals)
	}
	if h["valuesObject"].(map[string]any)["auth"].(map[string]any)["token"] != "t0ken-value" {
		t.Fatalf("valuesObject = %v", h["valuesObject"])
	}
	ps := h["parameters"].([]any)
	if ps[0].(map[string]any)["value"] != "k3y-value" || ps[1].(map[string]any)["value"] != "2.0.0" {
		t.Fatalf("parameters = %v", ps)
	}
	srcs, _, _ := unstructured.NestedSlice(edited.Object, "spec", "sources")
	if v := srcs[1].(map[string]any)["helm"].(map[string]any)["values"].(string); !strings.Contains(v, "m4il-pass") {
		t.Fatalf("sources[1] values = %q", v)
	}
	if a := edited.GetAnnotations()[lastApplied]; !strings.Contains(a, "hunter2-db") {
		t.Fatalf("the last-applied copy must be put back as it is live: %q", a)
	}

	// A typed value wins over the live one.
	typed := fluxRelease()
	_ = unstructured.SetNestedField(typed.Object, "new-cred", "spec", "values", "credentials")
	if err := unmaskGitOpsValues(c, fluxHelmRelease, true, typed); err != nil {
		t.Fatal(err)
	}
	if v, _, _ := unstructured.NestedString(typed.Object, "spec", "values", "credentials"); v != "new-cred" {
		t.Fatalf("typed value = %q", v)
	}

	// A hidden key the live object does not have is refused, never sent.
	orphan := fluxRelease()
	_ = unstructured.SetNestedField(orphan.Object, redactedValue, "spec", "values", "password")
	if err := unmaskGitOpsValues(c, fluxHelmRelease, true, orphan); err == nil {
		t.Fatal("a placeholder with no live value must be refused")
	}
}

// Values text that is not valid YAML is hidden whole and comes back whole.
func TestUnreadableGitOpsValuesAreHiddenWhole(t *testing.T) {
	app := argoApp()
	_ = unstructured.SetNestedField(app.Object, "password: [unclosed\n  hunter2-db", "spec", "source", "helm", "values")
	shown := app.DeepCopy()
	maskGitOpsValues(shown)
	if v, _, _ := unstructured.NestedString(shown.Object, "spec", "source", "helm", "values"); v != redactedValue {
		t.Fatalf("unreadable values shown as %q", v)
	}
}
