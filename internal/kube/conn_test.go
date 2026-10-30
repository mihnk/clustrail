package kube

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	authzv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
	metricsfake "k8s.io/metrics/pkg/client/clientset/versioned/fake"
)

type recorder struct {
	mu     sync.Mutex
	events []struct {
		name string
		data any
	}
}

func (r *recorder) Emit(name string, data any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, struct {
		name string
		data any
	}{name, data})
}

func (r *recorder) deltas(kind string) []Delta {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []Delta
	for _, e := range r.events {
		if d, ok := e.data.(Delta); ok && e.name == EventDelta && d.Kind == kind {
			out = append(out, d)
		}
	}
	return out
}

func (r *recorder) jobs() []Job {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []Job
	for _, e := range r.events {
		if j, ok := e.data.(Job); ok {
			out = append(out, j)
		}
	}
	return out
}

// newFakeConn returns a connection backed by fake clients, with every RBAC check allowed.
func newFakeConn(t *testing.T, objs ...runtime.Object) (*clusterConn, *fake.Clientset, *recorder) {
	t.Helper()
	client := fake.NewClientset(objs...)
	client.PrependReactor("create", "selfsubjectaccessreviews", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, &authzv1.SelfSubjectAccessReview{Status: authzv1.SubjectAccessReviewStatus{Allowed: true}}, nil
	})
	rec := &recorder{}
	dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
	c := connFromClients("test", func() Environment { return EnvStg }, rec, func(ConnectionState, error) {}, client, dyn, metricsfake.NewSimpleClientset())
	return c, client, rec
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestConnSendsResetThenDeltas(t *testing.T) {
	c, client, rec := newFakeConn(t, pod("a", nil), deployment(nil))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := c.start(ctx, "tester", false); err != nil {
		t.Fatal(err)
	}
	defer c.stop()

	waitFor(t, "initial reset", func() bool { return len(rec.deltas("pods")) > 0 })
	first := rec.deltas("pods")[0]
	if !first.Reset || len(first.Upserts) != 1 || first.Cluster != "test" {
		t.Fatalf("first delta = %+v", first)
	}
	if deps := rec.deltas("deployments"); len(deps) == 0 || len(deps[0].Upserts) != 1 {
		t.Fatalf("deployments = %+v", deps)
	}

	// A new pod arrives as an upsert, a deleted one as a delete.
	_, err := client.CoreV1().Pods("payments").Create(ctx, pod("b", nil), metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "upsert of b", func() bool {
		for _, d := range rec.deltas("pods")[1:] {
			for _, u := range d.Upserts {
				if u.(PodRow).Name == "b" {
					return true
				}
			}
		}
		return false
	})
	if err := client.CoreV1().Pods("payments").Delete(ctx, "a", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "delete of a", func() bool {
		for _, d := range rec.deltas("pods") {
			for _, id := range d.Deletes {
				if id == "test/payments/a" {
					return true
				}
			}
		}
		return false
	})
}

func TestForbiddenResourcesAreReported(t *testing.T) {
	client := fake.NewClientset()
	client.PrependReactor("create", "selfsubjectaccessreviews", func(a k8stesting.Action) (bool, runtime.Object, error) {
		r := a.(k8stesting.CreateAction).GetObject().(*authzv1.SelfSubjectAccessReview)
		return true, &authzv1.SelfSubjectAccessReview{Status: authzv1.SubjectAccessReviewStatus{Allowed: r.Spec.ResourceAttributes.Resource != "nodes"}}, nil
	})
	rec := &recorder{}
	c := connFromClients("test", func() Environment { return EnvDev }, rec, func(ConnectionState, error) {}, client, dynamicfake.NewSimpleDynamicClient(runtime.NewScheme()), metricsfake.NewSimpleClientset())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := c.start(ctx, "sre-readonly", false); err != nil {
		t.Fatal(err)
	}
	defer c.stop()
	if len(c.forbidden) != 1 || c.forbidden[0].Resource != "nodes" || c.forbidden[0].User != "sre-readonly" {
		t.Fatalf("forbidden = %+v", c.forbidden)
	}
	if c.nodes != nil {
		t.Fatal("no node informer may start without list permission")
	}
}

func TestNamespaceFallbackWhenClusterWideDenied(t *testing.T) {
	mk := func(ns, name string) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}, Status: corev1.PodStatus{Phase: corev1.PodRunning}}
	}
	client := fake.NewClientset(mk("payments", "mine"), mk("kube-system", "theirs"))
	// A namespace-admin: pods only in "payments", nothing cluster-wide.
	client.PrependReactor("create", "selfsubjectaccessreviews", func(a k8stesting.Action) (bool, runtime.Object, error) {
		ra := a.(k8stesting.CreateAction).GetObject().(*authzv1.SelfSubjectAccessReview).Spec.ResourceAttributes
		return true, &authzv1.SelfSubjectAccessReview{Status: authzv1.SubjectAccessReviewStatus{Allowed: ra.Namespace == "payments" && ra.Resource == "pods"}}, nil
	})
	rec := &recorder{}
	c := connFromClients("test", func() Environment { return EnvDev }, rec, func(ConnectionState, error) {}, client, dynamicfake.NewSimpleDynamicClient(runtime.NewScheme()), metricsfake.NewSimpleClientset())
	c.fallbackNS = "payments"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := c.start(ctx, "dev-team", false); err != nil {
		t.Fatal(err)
	}
	defer c.stop()

	var pods *Forbidden
	for i, f := range c.forbidden {
		if f.Resource == "pods" {
			pods = &c.forbidden[i]
		} else if f.Shown != "" {
			t.Fatalf("%s must not fall back: %+v", f.Resource, f)
		}
	}
	if pods == nil || pods.Shown != "payments" || pods.User != "dev-team" {
		t.Fatalf("forbidden = %+v", c.forbidden)
	}
	if c.podsNS != "payments" || c.deploys != nil || c.nodes != nil {
		t.Fatalf("podsNS=%q deploys=%v nodes=%v", c.podsNS, c.deploys != nil, c.nodes != nil)
	}
	waitFor(t, "pods reset", func() bool { return len(rec.deltas("pods")) > 0 })
	for _, d := range rec.deltas("pods") {
		for _, u := range d.Upserts {
			if p := u.(PodRow); p.Namespace != "payments" {
				t.Fatalf("pod outside the allowed namespace listed: %+v", p)
			}
		}
	}
}

func managerWith(c *clusterConn, readOnly bool) *Manager {
	m := &Manager{state: map[string]*Cluster{c.id: {ID: c.id, ReadOnly: readOnly}}, conns: map[string]*clusterConn{c.id: c}, emit: c.emit, ctx: context.Background()}
	return m
}

func TestReadOnlyBlocksChanges(t *testing.T) {
	c, _, _ := newFakeConn(t, pod("a", nil))
	m := managerWith(c, true)
	if err := m.DeletePod("test", "payments", "a"); err != ErrReadOnly {
		t.Fatalf("err = %v", err)
	}
	if _, err := m.StartExec(ExecRequest{Cluster: "test"}); err != ErrReadOnly {
		t.Fatalf("exec err = %v", err)
	}
}

func TestRestartScaleRollback(t *testing.T) {
	ctx := context.Background()
	d := deployment(nil)
	d.Spec.Selector = &metav1.LabelSelector{MatchLabels: map[string]string{"app": "checkout-api"}}
	rs := &appsv1.ReplicaSet{
		ObjectMeta: metav1.ObjectMeta{Name: "checkout-api-5f6b9d8c7", Namespace: "payments", Labels: map[string]string{"app": "checkout-api"},
			Annotations:     map[string]string{"deployment.kubernetes.io/revision": "13"},
			OwnerReferences: []metav1.OwnerReference{{Kind: "Deployment", Name: "checkout-api", UID: d.UID, Controller: ptr(true)}}},
		Spec: appsv1.ReplicaSetSpec{Template: corev1.PodTemplateSpec{
			ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "checkout-api", appsv1.DefaultDeploymentUniqueLabelKey: "5f6b9d8c7"}},
			Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "api", Image: "ghcr.io/acme/checkout-api:v2.30.4"}}},
		}},
	}
	c, client, _ := newFakeConn(t, d, rs)
	m := managerWith(c, false)

	if err := m.RestartDeployment("test", "payments", "checkout-api"); err != nil {
		t.Fatal(err)
	}
	got, _ := client.AppsV1().Deployments("payments").Get(ctx, "checkout-api", metav1.GetOptions{})
	if got.Spec.Template.Annotations["kubectl.kubernetes.io/restartedAt"] == "" {
		t.Fatal("restart did not stamp the pod template")
	}

	if err := m.RollbackDeployment("test", "payments", "checkout-api", 13); err != nil {
		t.Fatal(err)
	}
	got, _ = client.AppsV1().Deployments("payments").Get(ctx, "checkout-api", metav1.GetOptions{})
	if img := got.Spec.Template.Spec.Containers[0].Image; img != "ghcr.io/acme/checkout-api:v2.30.4" {
		t.Fatalf("image after rollback = %s", img)
	}
	if _, ok := got.Spec.Template.Labels[appsv1.DefaultDeploymentUniqueLabelKey]; ok {
		t.Fatal("pod-template-hash must not be copied into the Deployment")
	}
	if err := m.RollbackDeployment("test", "payments", "checkout-api", 9); err == nil || !strings.Contains(err.Error(), "revision 9") {
		t.Fatalf("missing revision err = %v", err)
	}
}

func TestDrainPlanAndPDBRetry(t *testing.T) {
	mk := func(name string, f func(p *corev1.Pod)) corev1.Pod {
		p := pod(name, f)
		p.Spec.NodeName = "node-1"
		return *p
	}
	rsOwned := func(p *corev1.Pod) {
		p.OwnerReferences = []metav1.OwnerReference{{Kind: "ReplicaSet", Name: "rs", Controller: ptr(true)}}
	}
	pods := []corev1.Pod{
		mk("web", rsOwned),
		mk("ds", func(p *corev1.Pod) {
			p.OwnerReferences = []metav1.OwnerReference{{Kind: "DaemonSet", Name: "fluent", Controller: ptr(true)}}
		}),
		mk("bare", nil),
		mk("cache", func(p *corev1.Pod) {
			rsOwned(p)
			p.Spec.Volumes = []corev1.Volume{{Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}}}
		}),
	}
	plan := drainPlan(pods, DrainOptions{})
	if len(plan.DaemonSet) != 1 || len(plan.Unmanaged) != 1 || len(plan.EmptyDir) != 1 || plan.Blocked == "" {
		t.Fatalf("plan = %+v", plan)
	}
	if p := drainPlan(pods, DrainOptions{Force: true, DeleteEmptyDir: true}); p.Blocked != "" || len(p.Evict) != 3 {
		t.Fatalf("forced plan = %+v", p)
	}

	// The first eviction of "web" is refused by a PDB (429), the retry succeeds.
	objs := []runtime.Object{&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "node-1"}}}
	for i := range pods[:1] {
		objs = append(objs, &pods[i])
	}
	c, client, rec := newFakeConn(t, objs...)
	c.ctx = context.Background()
	defer func(d time.Duration) { evictRetry = d }(evictRetry)
	evictRetry = 50 * time.Millisecond
	refused := 0
	client.PrependReactor("create", "pods", func(a k8stesting.Action) (bool, runtime.Object, error) {
		if a.GetSubresource() != "eviction" {
			return false, nil, nil
		}
		if refused == 0 {
			refused++
			return true, nil, apierrors.NewTooManyRequests("Cannot evict pod as it would violate the pod's disruption budget.", 1)
		}
		return true, &policyv1.Eviction{}, nil
	})
	m := managerWith(c, false)
	if _, err := m.DrainNode("test", "node-1", DrainOptions{TimeoutSec: 30}, "jane"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "drain done", func() bool {
		js := rec.jobs()
		return len(js) > 0 && js[len(js)-1].Done
	})
	jobs := rec.jobs()
	if last := jobs[len(jobs)-1]; last.Error != "" || last.Progress != 1 {
		t.Fatalf("last job = %+v", last)
	}
	if !strings.Contains(jobs[0].Detail, "waiting for PodDisruptionBudget") {
		t.Fatalf("first report should name the PDB wait: %+v", jobs[0])
	}
	node, _ := client.CoreV1().Nodes().Get(context.Background(), "node-1", metav1.GetOptions{})
	if !node.Spec.Unschedulable || node.Annotations["clustrail.io/cordoned-by"] != "jane" {
		t.Fatalf("node not cordoned: %+v", node.Spec)
	}
}

func encodeRelease(t *testing.T, r map[string]any) []byte {
	t.Helper()
	raw, _ := json.Marshal(r)
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	_, _ = zw.Write(raw)
	_ = zw.Close()
	return []byte(base64.StdEncoding.EncodeToString(buf.Bytes()))
}

func TestHelmReleasesFromSecrets(t *testing.T) {
	// Independent of the Helm repositories on the machine running the tests.
	t.Setenv("HELM_REPOSITORY_CACHE", t.TempDir())
	rel := func(version int, status, chartVersion, app string) *corev1.Secret {
		return &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: "sh.helm.release.v1.payments-workers.v" + itoa(version), Namespace: "payments", Labels: map[string]string{"owner": "helm"}},
			Type:       "helm.sh/release.v1",
			Data: map[string][]byte{"release": encodeRelease(t, map[string]any{
				"name": "payments-workers", "namespace": "payments", "version": version,
				"info": map[string]any{"status": status, "last_deployed": now.Add(-time.Duration(10-version) * time.Hour).Format(time.RFC3339), "description": "Upgrade complete"},
				"chart": map[string]any{
					"metadata": map[string]any{"name": "payments-workers", "version": chartVersion, "appVersion": app},
					"values":   map[string]any{"replicaCount": 1, "queue": map[string]any{"url": "amqp://q", "password": "default-secret"}, "image": map[string]any{"tag": "latest"}},
				},
				"hooks":    []any{map[string]any{"name": "db-migrate-check", "kind": "Job", "events": []any{"post-upgrade", "post-rollback"}}},
				"config":   map[string]any{"replicaCount": 3, "queue": map[string]any{"password": "hunter2"}},
				"manifest": "---\nkind: Deployment\nmetadata:\n  name: payments-workers\n---\nkind: CronJob\nmetadata:\n  name: reconcile\n",
			})},
		}
	}
	c, _, rec := newFakeConn(t, rel(7, "deployed", "2.3.2", "1.8.4"), rel(8, "failed", "2.4.0", "1.9.0"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.helm = newHelmWatcher(c, "me")
	c.helm.start(ctx)
	waitFor(t, "helm delta", func() bool { return len(rec.deltas("helm")) > 0 })
	rows := rec.deltas("helm")[0].Upserts
	if len(rows) != 1 {
		t.Fatalf("releases = %d", len(rows))
	}
	r := rows[0].(HelmRelease)
	if r.Revision != 8 || r.Status != "failed" || r.Health != Failed || len(r.History) != 2 || r.History[1].AppVersion != "1.8.4" {
		t.Fatalf("release = %+v", r)
	}
	if strings.Contains(r.Values, "hunter2") || !strings.Contains(r.Values, "redacted") {
		t.Fatalf("values not redacted:\n%s", r.Values)
	}
	if len(r.Resources) != 2 || r.Resources[1].Kind != "CronJob" {
		t.Fatalf("resources = %+v", r.Resources)
	}

	m := managerWith(c, false)
	d, err := m.GetHelmRevision("test", "payments", "payments-workers", 7)
	if err != nil {
		t.Fatal(err)
	}
	// User values win over chart defaults, maps merge, credentials stay redacted.
	for _, want := range []string{"replicaCount: 3", "url: amqp://q", "tag: latest", "redacted"} {
		if !strings.Contains(d.Computed, want) {
			t.Errorf("computed values lack %q:\n%s", want, d.Computed)
		}
	}
	if strings.Contains(d.Computed, "default-secret") || strings.Contains(d.Computed, "hunter2") {
		t.Errorf("computed values leak a credential:\n%s", d.Computed)
	}
	if len(d.Hooks) != 1 || d.Hooks[0].Kind != "Job" || d.Hooks[0].Events[1] != "post-rollback" {
		t.Errorf("hooks = %+v", d.Hooks)
	}
	if !strings.Contains(d.Manifest, "kind: CronJob") {
		t.Errorf("manifest = %q", d.Manifest)
	}
	if _, err := m.GetHelmRevision("test", "payments", "payments-workers", 3); err == nil {
		t.Error("a missing revision must be an error")
	}
}

func TestOwnersFromManagedFields(t *testing.T) {
	obj := &unstructured.Unstructured{}
	obj.SetManagedFields([]metav1.ManagedFieldsEntry{
		{Manager: "argocd-controller", Operation: "Apply", FieldsType: "FieldsV1", FieldsV1: &metav1.FieldsV1{Raw: []byte(
			`{"f:spec":{"f:replicas":{},"f:template":{"f:spec":{"f:containers":{"k:{\"name\":\"api\"}":{".":{},"f:image":{},"f:resources":{"f:limits":{"f:memory":{}}}}}}}}}`)}},
		{Manager: "kube-controller-manager", Subresource: "status", FieldsV1: &metav1.FieldsV1{Raw: []byte(`{"f:status":{"f:replicas":{}}}`)}},
	})
	owners := ownersOf(obj)
	for _, path := range []string{"spec.replicas", "spec.template.spec.containers[api].image", "spec.template.spec.containers[api].resources.limits.memory"} {
		if owners[path] != "argocd-controller" {
			t.Errorf("owners[%q] = %q (all: %v)", path, owners[path], owners)
		}
	}
	if _, ok := owners["status.replicas"]; ok {
		t.Error("status subresource must not count as ownership")
	}
}

func TestLoadKubeconfigMergesFiles(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "config")
	b := filepath.Join(dir, "perf.yaml")
	write := func(path, body string) {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(a, `apiVersion: v1
kind: Config
clusters:
- name: eks
  cluster: {server: "https://ABC.gr7.eu-west-1.eks.amazonaws.com"}
- name: kind
  cluster: {server: "https://127.0.0.1:6443"}
users:
- name: aws
  user:
    exec: {apiVersion: client.authentication.k8s.io/v1beta1, command: aws, args: [eks, get-token, --cluster-name, prod, --profile, sre]}
- name: kind
  user: {client-certificate-data: Zm9v, client-key-data: YmFy}
contexts:
- name: arn:aws:eks:eu-west-1:482100000000:cluster/prod-eu-west-1
  context: {cluster: eks, user: aws}
- name: kind-local
  context: {cluster: kind, user: kind}
current-context: kind-local
`)
	write(b, `apiVersion: v1
kind: Config
clusters:
- name: gke
  cluster: {server: "https://34.91.204.7"}
users:
- name: gke
  user:
    exec: {apiVersion: client.authentication.k8s.io/v1beta1, command: gke-gcloud-auth-plugin}
contexts:
- name: gke_acme-staging_europe-west4_staging-perf
  context: {cluster: gke, user: gke}
- name: kind-local
  context: {cluster: gke, user: gke}
`)
	t.Setenv("KUBECONFIG", a+string(os.PathListSeparator)+b)
	kc := LoadKubeconfig(nil)
	if len(kc.Contexts) != 3 {
		t.Fatalf("contexts = %+v", kc.Contexts)
	}
	byName := map[string]KubeContext{}
	for _, c := range kc.Contexts {
		byName[c.Name] = c
	}
	eks := byName["arn:aws:eks:eu-west-1:482100000000:cluster/prod-eu-west-1"]
	if eks.DisplayName != "prod-eu-west-1" || eks.Auth != "exec · aws eks" {
		t.Fatalf("eks = %+v", eks)
	}
	if got := ReauthCommand("aws", kc.Merged.AuthInfos["aws"]); got != "aws sso login --profile sre" {
		t.Fatalf("reauth = %q", got)
	}
	// The first file that defines a context wins (kubectl semantics).
	if kind := byName["kind-local"]; kind.Server != "https://127.0.0.1:6443" || kind.Auth != "client cert" {
		t.Fatalf("kind = %+v", kind)
	}
	if gke := byName["gke_acme-staging_europe-west4_staging-perf"]; gke.DisplayName != "staging-perf" || gke.Auth != "exec · gcloud" {
		t.Fatalf("gke = %+v", gke)
	}
	if kc.Changed(nil) {
		t.Fatal("nothing changed yet")
	}
	future := time.Now().Add(time.Minute)
	_ = os.Chtimes(b, future, future)
	if !kc.Changed(nil) {
		t.Fatal("touching a kubeconfig must count as a change")
	}
}

func TestStoreNewContexts(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "contexts.json"))
	if err != nil {
		t.Fatal(err)
	}
	if s.IsNew("a") {
		t.Fatal("before the first run nothing is new")
	}
	_ = s.MarkKnown([]string{"a"})
	if s.IsNew("a") || !s.IsNew("b") {
		t.Fatal("only contexts added after the first run are new")
	}
	cs, ok := s.Settings("prod-eu-west-1", "prod-eu-west-1")
	if ok || cs.Env != EnvProd || !cs.Protected {
		t.Fatalf("default for a prod context must be protected: %+v", cs)
	}
	_ = s.SetSettings("b", ContextSettings{Env: EnvStg})
	s2, _ := OpenStore(s.path)
	if cs, ok := s2.Settings("b", "b"); !ok || cs.Env != EnvStg || s2.IsNew("b") {
		t.Fatalf("settings not persisted: %+v", cs)
	}
}

func TestGitOpsRowsFromArgoAndFlux(t *testing.T) {
	app := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
		"metadata": map[string]any{"name": "payments-gateway", "namespace": "argocd"},
		"spec": map[string]any{
			"destination": map[string]any{"namespace": "payments"},
			"source":      map[string]any{"repoURL": "https://github.com/acme/deploy", "path": "apps/payments-gateway/overlays/prod", "targetRevision": "main"},
			"syncPolicy":  map[string]any{"automated": map[string]any{"prune": true}},
		},
		"status": map[string]any{
			"sync":         map[string]any{"status": "OutOfSync", "revision": "8c41e2f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5"},
			"health":       map[string]any{"status": "Healthy"},
			"reconciledAt": now.Add(-41 * time.Second).Format(time.RFC3339),
			"resources":    []any{map[string]any{"kind": "Deployment", "name": "payments-gateway", "status": "OutOfSync", "health": map[string]any{"status": "Healthy"}}},
		},
	}}
	row := argoRow(app, now)
	if row.Sync != "OutOfSync" || row.Revision != "8c41e2f" || row.Policy.SelfHeal || !row.Policy.Prune || len(row.Drift) != 1 || row.ReconciledSeconds != 41 {
		t.Fatalf("argo row = %+v", row)
	}
	if gitopsHealth(row.Sync, row.AppHealth) != Warning {
		t.Fatal("OutOfSync is a warning")
	}

	ks := &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "ledger", "namespace": "flux-system"},
		"spec":     map[string]any{"path": "./apps/ledger/overlays/staging", "sourceRef": map[string]any{"kind": "GitRepository", "name": "deploy"}, "prune": true},
		"status": map[string]any{
			"lastAppliedRevision": "main@sha1:a90d3be1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7",
			"conditions":          []any{map[string]any{"type": "Ready", "status": "False", "reason": "ReconciliationFailed", "message": "kustomize build failed", "lastTransitionTime": now.Add(-34 * time.Minute).Format(time.RFC3339)}},
		},
	}}
	f := fluxRow(ks, fluxKustomize, now)
	if f.Sync != "Failed" || f.AppHealth != "Not ready" || f.Revision != "a90d3be" || f.Error != "kustomize build failed" {
		t.Fatalf("flux row = %+v", f)
	}
	_ = schema.GroupVersionResource{}
}

func TestCachedChartNames(t *testing.T) {
	dir := t.TempDir()
	index := "apiVersion: v1\nentries:\n  ingress-nginx:\n  - apiVersion: v2\n    name: ingress-nginx\n    version: 4.11.3\n  \"cert-manager\":\n  - name: cert-manager\ngenerated: \"2026-01-01T00:00:00Z\"\n"
	if err := os.WriteFile(filepath.Join(dir, "a-index.yaml"), []byte(index), 0o600); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "b-index.yaml"), []byte("ignored when charts.txt exists"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "b-charts.txt"), []byte("argo-cd\nargo-workflows\n"), 0o600)
	got := cachedChartNames(dir)
	for _, want := range []string{"ingress-nginx", "cert-manager", "argo-cd", "argo-workflows"} {
		if !got[want] {
			t.Errorf("missing %q in %v", want, got)
		}
	}
	if got["generated"] || got["apiVersion"] || got["name"] || len(got) != 4 {
		t.Errorf("unexpected names: %v", got)
	}
}

func TestDeploymentRelations(t *testing.T) {
	d := deployment(func(d *appsv1.Deployment) {
		d.Annotations = map[string]string{"meta.helm.sh/release-name": "checkout"}
		d.Spec.Template.Labels = map[string]string{"app": "checkout-api"}
		d.Spec.Template.Spec.Volumes = []corev1.Volume{{Name: "cfg", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: "checkout-config"}}}}}
		d.Spec.Template.Spec.Containers[0].Env = []corev1.EnvVar{{Name: "DB_PASSWORD", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: "checkout-db"}, Key: "password"}}}}
	})
	svc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "checkout-api", Namespace: "payments"}, Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "checkout-api"}}}
	other := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "other", Namespace: "payments"}, Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "other"}}}
	pdb := &policyv1.PodDisruptionBudget{ObjectMeta: metav1.ObjectMeta{Name: "checkout-api", Namespace: "payments"},
		Spec: policyv1.PodDisruptionBudgetSpec{Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "checkout-api"}}}}
	c, _, _ := newFakeConn(t, d, svc, other, pdb)
	rels, err := managerWith(c, false).DeploymentRelations("test", "payments", "checkout-api")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, r := range rels {
		names := []string{}
		for _, o := range r.Objects {
			names = append(names, o.Kind+"/"+o.Name)
		}
		got[r.Label] = strings.Join(names, ",")
	}
	want := map[string]string{"Selected by": "svc/checkout-api", "Disruption": "pdb/checkout-api", "Uses": "cm/checkout-config,secret/checkout-db", "Managed by": "helm/checkout"}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q (all: %v)", k, got[k], v, got)
		}
	}
}

func TestNodeRowsUpdateIncrementally(t *testing.T) {
	node := func(name string) *corev1.Node {
		return &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: name}, Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}}}
	}
	c, client, rec := newFakeConn(t, node("n1"), node("n2"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := c.start(ctx, "tester", false); err != nil {
		t.Fatal(err)
	}
	defer c.stop()
	waitFor(t, "node reset", func() bool { return len(rec.deltas("nodes")) > 0 })
	if d := rec.deltas("nodes")[0]; !d.Reset || len(d.Upserts) != 2 {
		t.Fatalf("first = %+v", d)
	}

	p := pod("on-n2", nil)
	p.Spec.NodeName = "n2"
	if _, err := client.CoreV1().Pods("payments").Create(ctx, p, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "n2 update", func() bool { return len(rec.deltas("nodes")) > 1 })
	d := rec.deltas("nodes")[1]
	if d.Reset || len(d.Upserts) != 1 {
		t.Fatalf("a pod on n2 must resend n2 only: %+v", d)
	}
	if row := d.Upserts[0].(NodeRow); row.ID != "test/n2" || row.Pods != 1 {
		t.Fatalf("row = %+v", row)
	}

	if err := client.CoreV1().Nodes().Delete(ctx, "n1", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "n1 delete", func() bool {
		for _, d := range rec.deltas("nodes") {
			if len(d.Deletes) == 1 && d.Deletes[0] == "test/n1" {
				return true
			}
		}
		return false
	})
}
