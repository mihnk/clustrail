//go:build envtest

package kube

import (
	"context"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
)

// Against a real API server: the metadata list reads last-applied, Helm's
// stored manifest is read from its Secret, and /metrics is parsed as served.
func TestAPIRemovalsAgainstAPIServer(t *testing.T) {
	bins := envtestBins(t)
	env := startEnvCluster(t, bins)
	admin := adminClient(t, env.host)
	ctx := context.Background()
	cfg := &rest.Config{Host: env.host, BearerToken: "admintoken", TLSClientConfig: rest.TLSClientConfig{Insecure: true}}

	for _, ns := range []string{"ops", "payments"} {
		_, _ = admin.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}, metav1.CreateOptions{})
	}
	// What kubectl apply leaves on an object it created from a batch/v1beta1 file.
	cj := &batchv1.CronJob{
		ObjectMeta: metav1.ObjectMeta{Name: "db-backup", Namespace: "ops", Annotations: map[string]string{lastApplied: `{"apiVersion":"batch/v1beta1","kind":"CronJob","metadata":{"name":"db-backup","namespace":"ops"}}`}},
		Spec: batchv1.CronJobSpec{Schedule: "0 3 * * *", JobTemplate: batchv1.JobTemplateSpec{Spec: batchv1.JobSpec{Template: corev1.PodTemplateSpec{Spec: corev1.PodSpec{
			RestartPolicy: corev1.RestartPolicyNever, Containers: []corev1.Container{{Name: "b", Image: "busybox"}},
		}}}}},
	}
	if _, err := admin.BatchV1().CronJobs("ops").Create(ctx, cj, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.CoreV1().Secrets("payments").Create(ctx, helmRelease(t, "billing", 3, "deployed", hpaV2beta2), metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	// A CRD version marked deprecated, then requested: the API server counts it.
	ext := dynamic.NewForConfigOrDie(cfg)
	version := func(name string, storage, deprecated bool) map[string]any {
		return map[string]any{"name": name, "served": true, "storage": storage, "deprecated": deprecated,
			"schema": map[string]any{"openAPIV3Schema": map[string]any{"type": "object"}}}
	}
	crd := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
		"metadata": map[string]any{"name": "widgets.example.io"},
		"spec": map[string]any{
			"group": "example.io", "scope": "Namespaced",
			"names":    map[string]any{"plural": "widgets", "singular": "widget", "kind": "Widget", "listKind": "WidgetList"},
			"versions": []any{version("v1", true, false), version("v1alpha1", false, true)},
		},
	}}
	crdGVR := schema.GroupVersionResource{Group: "apiextensions.k8s.io", Version: "v1", Resource: "customresourcedefinitions"}
	if _, err := ext.Resource(crdGVR).Create(ctx, crd, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	widgets := schema.GroupVersionResource{Group: "example.io", Version: "v1alpha1", Resource: "widgets"}
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(200 * time.Millisecond) {
		if _, err := ext.Resource(widgets).Namespace("ops").List(ctx, metav1.ListOptions{}); err == nil {
			break
		} else if time.Now().After(deadline) {
			t.Fatalf("deprecated CRD version not served: %v", err)
		}
	}

	m := chaosManager(t, env.host)
	r, err := m.APIRemovals("envtest")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("report: %+v", r)
	if r.Minor != 32 || r.Releases != 1 {
		t.Fatalf("server %q, releases %d", r.Server, r.Releases)
	}
	has := func(source, apiVersion, name string) bool {
		for _, f := range r.Findings {
			if f.Source == source && f.APIVersion == apiVersion && (name == "" || f.Name == name) {
				return true
			}
		}
		return false
	}
	if !has("applied", "batch/v1beta1", "db-backup") {
		t.Error("last-applied CronJob not found")
	}
	if !has("helm", "autoscaling/v2beta2", "billing-workers") {
		t.Error("Helm manifest HPA not found")
	}
	if !has("apiserver", "example.io/v1alpha1", "") {
		t.Errorf("deprecated CRD version not counted; notes %q", r.Notes)
	}
	if r.APIServerStarted == "" {
		t.Error("API server start time not read")
	}

	// The sidebar's custom resources: the CRD's kind is custom, built-in kinds are not.
	kinds, err := m.ResourceKinds("envtest")
	if err != nil {
		t.Fatal(err)
	}
	custom := map[string]bool{}
	for _, k := range kinds {
		custom[k.Group+"/"+k.Kind] = k.Custom
	}
	if !custom["example.io/Widget"] || custom["/Pod"] || custom["apps/Deployment"] || custom["apiextensions.k8s.io/CustomResourceDefinition"] {
		t.Errorf("custom flags: Widget %v, Pod %v, Deployment %v, CRD %v", custom["example.io/Widget"], custom["/Pod"], custom["apps/Deployment"], custom["apiextensions.k8s.io/CustomResourceDefinition"])
	}
}
