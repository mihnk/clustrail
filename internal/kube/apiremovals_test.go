package kube

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/version"
	metafake "k8s.io/client-go/metadata/fake"
	k8stesting "k8s.io/client-go/testing"
)

func TestRemovalTableComesFromLifecycleTags(t *testing.T) {
	want := map[string]APIRemoval{
		"batch/v1beta1 CronJob":                           {Removed: "1.25", Replacement: "batch/v1"},
		"policy/v1beta1 PodDisruptionBudget":              {Removed: "1.25", Replacement: "policy/v1"},
		"networking.k8s.io/v1beta1 Ingress":               {Removed: "1.22", Replacement: "networking.k8s.io/v1"},
		"networking.k8s.io/v1beta1 IngressClass":          {Removed: "1.22", Replacement: "networking.k8s.io/v1"},
		"flowcontrol.apiserver.k8s.io/v1beta3 FlowSchema": {Removed: "1.32", Replacement: "flowcontrol.apiserver.k8s.io/v1"},
		// No longer in k8s.io/api: from the migration guide.
		"autoscaling/v2beta2 HorizontalPodAutoscaler": {Removed: "1.26", Replacement: "autoscaling/v2"},
		"autoscaling/v2beta1 HorizontalPodAutoscaler": {Removed: "1.25", Replacement: "autoscaling/v2"},
		"policy/v1beta1 PodSecurityPolicy":            {Removed: "1.25"},
	}
	all := KnownAPIRemovals()
	got := map[string]APIRemoval{}
	for _, r := range all {
		got[r.groupVersion()+" "+r.Kind] = r
	}
	for k, w := range want {
		g, ok := got[k]
		if !ok {
			t.Errorf("%s: missing", k)
			continue
		}
		if g.Removed != w.Removed || g.Replacement != w.Replacement {
			t.Errorf("%s: removed %q → %q, want %q → %q", k, g.Removed, g.Replacement, w.Removed, w.Replacement)
		}
	}
	// Served versions are not in it.
	for _, k := range []string{"batch/v1 CronJob", "apps/v1 Deployment", "autoscaling/v2 HorizontalPodAutoscaler"} {
		if _, ok := got[k]; ok {
			t.Errorf("%s listed as removed", k)
		}
	}
	for i := 1; i < len(all); i++ {
		if compareRelease(all[i-1].Removed, all[i].Removed) > 0 {
			t.Fatalf("not sorted by release: %s before %s", all[i-1].Removed, all[i].Removed)
		}
	}
	if compareRelease("1.9", "1.25") >= 0 || compareRelease("1.25", "") >= 0 {
		t.Fatal("compareRelease orders by number, unknown last")
	}
}

func helmRelease(t *testing.T, name string, rev int, status, manifest string, hooks ...string) *corev1.Secret {
	t.Helper()
	var hs []map[string]any
	for i, h := range hooks {
		hs = append(hs, map[string]any{"name": name + "-hook-" + itoa(i), "kind": "Job", "manifest": h})
	}
	return &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "sh.helm.release.v1." + name + ".v" + itoa(rev), Namespace: "payments", Labels: map[string]string{"owner": "helm", "name": name}},
		Type:       "helm.sh/release.v1",
		Data: map[string][]byte{"release": encodeRelease(t, map[string]any{
			"name": name, "namespace": "payments", "version": rev,
			"info": map[string]any{"status": status}, "manifest": manifest, "hooks": hs,
		})},
	}
}

const hpaV2beta2 = `---
# Source: billing/templates/hpa.yaml
apiVersion: autoscaling/v2beta2
kind: HorizontalPodAutoscaler
metadata:
  name: billing-workers
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: billing-workers
`

func TestHelmManifestsRecordRemovedVersions(t *testing.T) {
	secrets := []*corev1.Secret{
		// Revision 14 is deployed with the old HPA; 15 failed with the fixed chart.
		helmRelease(t, "billing", 14, "superseded", "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: old\n"),
		helmRelease(t, "billing", 15, "deployed", hpaV2beta2, "apiVersion: batch/v1beta1\nkind: CronJob\nmetadata:\n  name: migrate\n  namespace: jobs\n"),
		helmRelease(t, "billing", 16, "failed", "apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: billing-workers\n"),
		helmRelease(t, "clean", 1, "deployed", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n"),
	}
	rels := currentReleases(secrets)
	if len(rels) != 2 {
		t.Fatalf("releases = %d, want 2", len(rels))
	}
	got := helmRemovals(rels)
	if len(got) != 2 {
		t.Fatalf("findings = %+v", got)
	}
	byKind := map[string]APIRemovalFinding{}
	for _, f := range got {
		byKind[f.Kind] = f
	}
	hpa := byKind["HorizontalPodAutoscaler"]
	if hpa.APIVersion != "autoscaling/v2beta2" || hpa.Removed != "1.26" || hpa.Replacement != "autoscaling/v2" ||
		hpa.Release != "billing" || hpa.Revision != 15 || hpa.Namespace != "payments" || hpa.Name != "billing-workers" || hpa.Hook {
		t.Fatalf("HPA finding = %+v (the deployed revision is the one Helm upgrades from)", hpa)
	}
	cj := byKind["CronJob"]
	if !cj.Hook || cj.Namespace != "jobs" || cj.Removed != "1.25" {
		t.Fatalf("hook finding = %+v", cj)
	}
}

type fakeRemovalDiscovery struct {
	minor     string
	resources []*metav1.APIResourceList
}

func (f fakeRemovalDiscovery) ServerVersion() (*version.Info, error) {
	return &version.Info{Major: "1", Minor: f.minor}, nil
}

func (f fakeRemovalDiscovery) ServerPreferredResources() ([]*metav1.APIResourceList, error) {
	return f.resources, nil
}

func partial(apiVersion, kind, ns, name, applied string) *metav1.PartialObjectMetadata {
	o := &metav1.PartialObjectMetadata{TypeMeta: metav1.TypeMeta{APIVersion: apiVersion, Kind: kind}, ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name}}
	if applied != "" {
		o.Annotations = map[string]string{lastApplied: applied}
	}
	return o
}

func TestLastAppliedRecordsTheVersionKubectlUsed(t *testing.T) {
	sch := runtime.NewScheme()
	_ = metav1.AddMetaToScheme(sch)
	mc := metafake.NewSimpleMetadataClient(sch,
		// Read back as batch/v1, applied as batch/v1beta1.
		partial("batch/v1", "CronJob", "ops", "db-backup", `{"apiVersion":"batch/v1beta1","kind":"CronJob","metadata":{"name":"db-backup"}}`),
		partial("batch/v1", "CronJob", "ops", "fresh", `{"apiVersion":"batch/v1","kind":"CronJob"}`),
		partial("batch/v1", "CronJob", "ops", "created", ""),
		partial("networking.k8s.io/v1", "Ingress", "web", "shop", `{"apiVersion":"extensions/v1beta1","kind":"Ingress"}`),
		partial("networking.k8s.io/v1", "Ingress", "web", "broken", `{not json`),
	)
	disc := fakeRemovalDiscovery{minor: "30+", resources: []*metav1.APIResourceList{
		{GroupVersion: "batch/v1", APIResources: []metav1.APIResource{{Name: "cronjobs", Kind: "CronJob", Namespaced: true, Verbs: []string{"list", "get"}}, {Name: "cronjobs/status", Kind: "CronJob", Verbs: []string{"get"}}}},
		{GroupVersion: "networking.k8s.io/v1", APIResources: []metav1.APIResource{{Name: "ingresses", Kind: "Ingress", Namespaced: true, Verbs: []string{"list"}}}},
		// Not a kind with removed versions: never listed.
		{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "configmaps", Kind: "ConfigMap", Namespaced: true, Verbs: []string{"list"}}}},
	}}
	r := scanRemovals(context.Background(), removalSources{cluster: "c", discovery: disc, meta: mc})
	if r.Server != "1.30" || r.Minor != 30 {
		t.Fatalf("server = %q / %d", r.Server, r.Minor)
	}
	if r.Objects != 5 {
		t.Fatalf("objects checked = %d, want 5", r.Objects)
	}
	if len(r.Findings) != 2 {
		t.Fatalf("findings = %+v", r.Findings)
	}
	// Sorted by release: the Ingress (1.22) before the CronJob (1.25).
	if f := r.Findings[0]; f.Source != "applied" || f.APIVersion != "extensions/v1beta1" || f.Name != "shop" || f.Removed != "1.22" {
		t.Fatalf("first = %+v", f)
	}
	if f := r.Findings[1]; f.APIVersion != "batch/v1beta1" || f.Namespace != "ops" || f.Name != "db-backup" || f.Replacement != "batch/v1" {
		t.Fatalf("second = %+v", f)
	}
}

func TestLastAppliedFallsBackToTheContextNamespace(t *testing.T) {
	sch := runtime.NewScheme()
	_ = metav1.AddMetaToScheme(sch)
	mc := metafake.NewSimpleMetadataClient(sch, partial("batch/v1", "CronJob", "team", "nightly", `{"apiVersion":"batch/v1beta1","kind":"CronJob"}`))
	mc.PrependReactor("list", "*", func(a k8stesting.Action) (bool, runtime.Object, error) {
		if a.GetNamespace() == "" {
			return true, nil, apierrors.NewForbidden(schema.GroupResource{Group: "batch", Resource: "cronjobs"}, "", nil)
		}
		return false, nil, nil
	})
	disc := fakeRemovalDiscovery{minor: "29", resources: []*metav1.APIResourceList{
		{GroupVersion: "batch/v1", APIResources: []metav1.APIResource{{Name: "cronjobs", Kind: "CronJob", Namespaced: true, Verbs: []string{"list"}}}},
		{GroupVersion: "rbac.authorization.k8s.io/v1", APIResources: []metav1.APIResource{{Name: "clusterroles", Kind: "ClusterRole", Verbs: []string{"list"}}}},
	}}
	r := scanRemovals(context.Background(), removalSources{cluster: "c", discovery: disc, meta: mc, fallbackNS: "team"})
	if len(r.Findings) != 1 || r.Findings[0].Name != "nightly" {
		t.Fatalf("findings = %+v", r.Findings)
	}
	notes := strings.Join(r.Notes, "\n")
	if !strings.Contains(notes, "CronJob: only namespace team") || !strings.Contains(notes, "ClusterRole: not allowed to list") {
		t.Fatalf("notes = %q", notes)
	}
}

const metricsText = `# HELP apiserver_requested_deprecated_apis [STABLE] Gauge of deprecated APIs that have been requested, broken out by API group, version, resource, subresource, and removed_release.
# TYPE apiserver_requested_deprecated_apis gauge
apiserver_requested_deprecated_apis{group="flowcontrol.apiserver.k8s.io",removed_release="1.32",resource="flowschemas",subresource="",version="v1beta3"} 1
apiserver_requested_deprecated_apis{group="flowcontrol.apiserver.k8s.io",removed_release="1.32",resource="flowschemas",subresource="status",version="v1beta3"} 1
apiserver_requested_deprecated_apis{group="flowcontrol.apiserver.k8s.io",removed_release="1.32",resource="prioritylevelconfigurations",subresource="",version="v1beta3"} 0
apiserver_requested_deprecated_apis{group="example.io",removed_release="",resource="widgets",subresource="",version="v1alpha1"} 1
apiserver_request_total{code="200",verb="GET"} 1234
# TYPE process_start_time_seconds gauge
process_start_time_seconds 1.7612e+09
`

func TestAPIServerCountsDeprecatedRequests(t *testing.T) {
	got, started, err := parseDeprecatedMetric(strings.NewReader(metricsText))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("findings = %+v (subresources and zero values are left out)", got)
	}
	fs := got[0]
	if fs.Source != "apiserver" || fs.APIVersion != "flowcontrol.apiserver.k8s.io/v1beta3" || fs.Resource != "flowschemas" ||
		fs.Kind != "FlowSchema" || fs.Removed != "1.32" || fs.Replacement != "flowcontrol.apiserver.k8s.io/v1" {
		t.Fatalf("flowschemas = %+v", fs)
	}
	// A CRD version marked deprecated without a release: the metric's own label, empty.
	if w := got[1]; w.Resource != "widgets" || w.Removed != "" || w.Kind != "" {
		t.Fatalf("widgets = %+v", w)
	}
	if started.Unix() != 1761200000 {
		t.Fatalf("started = %v", started)
	}
}

func TestMetricsForbiddenIsANote(t *testing.T) {
	disc := fakeRemovalDiscovery{minor: "31"}
	forbidden := func(context.Context) (io.ReadCloser, error) {
		return nil, apierrors.NewForbidden(schema.GroupResource{}, "/metrics", nil)
	}
	r := scanRemovals(context.Background(), removalSources{cluster: "c", discovery: disc, metrics: forbidden})
	if !strings.Contains(strings.Join(r.Notes, "\n"), "API server metrics: not allowed") {
		t.Fatalf("notes = %q", r.Notes)
	}
	ok := func(context.Context) (io.ReadCloser, error) { return io.NopCloser(strings.NewReader(metricsText)), nil }
	r = scanRemovals(context.Background(), removalSources{cluster: "c", discovery: disc, metrics: ok})
	if len(r.Findings) != 2 || r.APIServerStarted != time.Unix(1761200000, 0).UTC().Format(time.RFC3339) {
		t.Fatalf("report = %+v", r)
	}
}
