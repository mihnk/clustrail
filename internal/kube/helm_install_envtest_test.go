//go:build envtest

package kube

import (
	"context"
	"strings"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func waitJob(t *testing.T, m *Manager, id string) Job {
	t.Helper()
	for deadline := time.Now().Add(60 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		for _, j := range m.Jobs() {
			if j.ID == id && j.Done {
				return j
			}
		}
	}
	t.Fatalf("job %s did not finish", id)
	return Job{}
}

// Install a chart from a served repository into a namespace that does not
// exist yet, then uninstall it, against a real API server.
func TestHelmInstallAndUninstall(t *testing.T) {
	bins := envtestBins(t)
	env := startEnvCluster(t, bins)
	admin := adminClient(t, env.host)
	testChartRepo(t, testChart("hello", "1.2.0", "test"))
	m := chaosManager(t, env.host)
	ctx := context.Background()

	req := HelmInstallRequest{Cluster: "envtest", Namespace: "tools", Name: "hi", Repo: "acme", Chart: "hello", Version: "1.2.0", Values: "message: from-clustrail\n", CreateNamespace: true, TimeoutSec: 60}
	// Without creating it, a missing namespace is refused.
	noNS := req
	noNS.CreateNamespace = false
	if _, err := m.PlanHelmInstall(noNS); err == nil {
		t.Fatal("plan into a missing namespace without creating it passed")
	}
	plan, err := m.PlanHelmInstall(req)
	if err != nil {
		t.Fatal(err)
	}
	if !plan.RenderedOnly || len(plan.Objects) != 2 {
		t.Fatalf("plan = %+v", plan)
	}
	for _, o := range plan.Objects {
		if o.Change != "added" {
			t.Fatalf("object %s/%s: %s", o.Kind, o.Name, o.Change)
		}
		if o.Kind == "Secret" && (o.After == "" || strings.Contains(o.After, "hunter2")) {
			t.Fatalf("secret value shown in the plan: %q", o.After)
		}
	}
	job := waitJob(t, m, mustID(t)(m.InstallRelease(req)))
	if job.State != JobSucceeded {
		t.Fatalf("install job = %+v", job)
	}
	cm, err := admin.CoreV1().ConfigMaps("tools").Get(ctx, "hi-config", metav1.GetOptions{})
	if err != nil || cm.Data["message"] != "from-clustrail" {
		t.Fatalf("configmap = %+v, %v", cm, err)
	}
	// Now the namespace exists: the plan is a server dry run.
	again := req
	again.Name = "hi2"
	if p, err := m.PlanHelmInstall(again); err != nil || p.RenderedOnly {
		t.Fatalf("second plan = %+v, %v", p, err)
	}

	job = waitJob(t, m, mustID(t)(m.UninstallRelease("envtest", "tools", "hi", false)))
	if job.State != JobSucceeded {
		t.Fatalf("uninstall job = %+v", job)
	}
	if _, err := admin.CoreV1().ConfigMaps("tools").Get(ctx, "hi-config", metav1.GetOptions{}); !apierrors.IsNotFound(err) {
		t.Fatalf("configmap still there: %v", err)
	}
	secrets, _ := admin.CoreV1().Secrets("tools").List(ctx, metav1.ListOptions{LabelSelector: "owner=helm"})
	if len(secrets.Items) != 0 {
		t.Fatalf("release history left: %d", len(secrets.Items))
	}
}

func mustID(t *testing.T) func(string, error) string {
	return func(id string, err error) string {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
}
