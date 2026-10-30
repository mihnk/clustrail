package kube

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const manifestV1 = `---
# Source: w/templates/deploy.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: workers
spec:
  replicas: 3
---
# Source: w/templates/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: workers-env
data:
  DB_PASSWORD: aHVudGVyMg==
  REGION: ZXU=
---
# Source: w/templates/sm.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: workers-v2
  namespace: monitoring
`

const manifestV2 = `---
# Source: w/templates/deploy.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: workers
spec:
  replicas: 5
---
# Source: w/templates/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: workers-env
data:
  DB_PASSWORD: c3dvcmRmaXNo
  REGION: ZXU=
---
# Source: w/templates/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: workers
`

func TestDiffManifestsPerObjectWithHiddenSecrets(t *testing.T) {
	objs := diffManifests(manifestV1, manifestV2, "payments")
	got := map[string]HelmObjectChange{}
	for _, o := range objs {
		got[o.Kind+"/"+o.Name] = o
	}
	if len(objs) != 4 || objs[0].Change != "changed" || objs[len(objs)-1].Change != "removed" {
		t.Fatalf("order/changes = %+v", objs)
	}
	if got["Deployment/workers"].Change != "changed" || got["HorizontalPodAutoscaler/workers"].Change != "added" || got["ServiceMonitor/workers-v2"].Change != "removed" {
		t.Fatalf("changes = %+v", got)
	}
	if got["ServiceMonitor/workers-v2"].Namespace != "monitoring" || got["Deployment/workers"].Namespace != "payments" {
		t.Fatal("namespaces: explicit kept, empty defaults to the release's")
	}
	sec := got["Secret/workers-env"]
	if sec.Change != "changed" {
		t.Fatalf("secret change = %q", sec.Change)
	}
	for _, text := range []string{sec.Before, sec.After} {
		if strings.Contains(text, "aHVudGVyMg") || strings.Contains(text, "c3dvcmRmaXNo") || strings.Contains(text, "ZXU=") {
			t.Fatalf("secret value leaked:\n%s", text)
		}
	}
	if !strings.Contains(sec.After, "DB_PASSWORD: (hidden, 9 bytes, changed)") || !strings.Contains(sec.After, "REGION: (hidden, 2 bytes)") {
		t.Fatalf("masked secret:\n%s", sec.After)
	}
}

func TestUpgradeValuesKeepRedactedLiveValues(t *testing.T) {
	live := map[string]any{"db": map[string]any{"password": "hunter2", "host": "pg"}, "replicaCount": float64(3)}
	shown := toYAML(live, "{}")
	if strings.Contains(shown, "hunter2") || !strings.Contains(shown, redactedValue) {
		t.Fatalf("shown values:\n%s", shown)
	}
	edited := strings.Replace(shown, "replicaCount: 3", "replicaCount: 5", 1)
	vals, err := parseUpgradeValues(edited, live)
	if err != nil {
		t.Fatal(err)
	}
	if vals["db"].(map[string]any)["password"] != "hunter2" || vals["replicaCount"] != float64(5) {
		t.Fatalf("values = %v", vals)
	}
	if keys := changedKeys(live, vals); len(keys) != 1 || keys[0] != "replicaCount" {
		t.Fatalf("changed keys = %v", keys)
	}
	if _, err := parseUpgradeValues("token: \""+redactedValue+"\"\n", live); err == nil {
		t.Fatal("a placeholder where the release has no value must be refused")
	}
	if _, err := parseUpgradeValues("a: [", live); err == nil {
		t.Fatal("invalid YAML must be refused")
	}
	if vals, err := parseUpgradeValues("", live); err != nil || len(vals) != 0 {
		t.Fatalf("empty values = chart defaults: %v %v", vals, err)
	}
}

func TestChartVersionsFromLocalRepositoryIndexes(t *testing.T) {
	dir := t.TempDir()
	cache := filepath.Join(dir, "cache")
	os.MkdirAll(cache, 0o755)
	os.WriteFile(filepath.Join(dir, "repositories.yaml"), []byte(`repositories:
- name: acme
  url: https://charts.acme.example
  username: ci
  password: s3cret
- name: other
  url: https://other.example
`), 0o600)
	os.WriteFile(filepath.Join(cache, "acme-index.yaml"), []byte(`apiVersion: v1
entries:
  payments-workers:
  - name: payments-workers
    version: 2.5.0
    appVersion: 1.10.0
    urls: [payments-workers-2.5.0.tgz]
  - name: payments-workers
    version: 2.4.1
    appVersion: 1.9.1
    urls: [payments-workers-2.4.1.tgz]
`), 0o600)
	os.WriteFile(filepath.Join(cache, "other-charts.txt"), []byte("unrelated\n"), 0o600)
	t.Setenv("HELM_REPOSITORY_CONFIG", filepath.Join(dir, "repositories.yaml"))
	t.Setenv("HELM_REPOSITORY_CACHE", cache)

	vs, note := chartVersions("payments-workers")
	if note != "" || len(vs) != 2 || vs[0].Repo != "acme" || vs[0].Version != "2.5.0" || vs[0].AppVersion != "1.10.0" {
		t.Fatalf("versions = %+v %q", vs, note)
	}
	if vs, note := chartVersions("nope"); len(vs) != 0 || note == "" {
		t.Fatalf("missing chart = %+v %q", vs, note)
	}
	// Credentials stay in the backend.
	repos, _ := HelmRepositories()
	if len(repos) != 2 || repos[0].URL != "https://charts.acme.example" {
		t.Fatalf("repos = %+v", repos)
	}
	entries, _ := helmRepoEntries()
	if entries[0].Password != "s3cret" {
		t.Fatalf("entries = %+v", entries)
	}
}
