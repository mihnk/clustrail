package kube

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"helm.sh/helm/v4/pkg/chart/common"
	chartv2 "helm.sh/helm/v4/pkg/chart/v2"
	chartutil "helm.sh/helm/v4/pkg/chart/v2/util"
	repov1 "helm.sh/helm/v4/pkg/repo/v1"
)

// testChartRepo serves a chart repository with the given charts and points
// Helm's settings at it as repository "acme". It returns the server URL.
func testChartRepo(t *testing.T, charts ...*chartv2.Chart) string {
	t.Helper()
	repoDir, home := t.TempDir(), t.TempDir()
	for _, ch := range charts {
		if _, err := chartutil.Save(ch, repoDir); err != nil {
			t.Fatal(err)
		}
	}
	srv := httptest.NewServer(http.FileServer(http.Dir(repoDir)))
	t.Cleanup(srv.Close)
	idx, err := repov1.IndexDirectory(repoDir, srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	idx.SortEntries()
	if err := idx.WriteFile(filepath.Join(repoDir, "index.yaml"), 0o644); err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(home, "cache", "repository")
	_ = os.MkdirAll(cache, 0o755)
	if err := idx.WriteFile(filepath.Join(cache, "acme-index.yaml"), 0o644); err != nil {
		t.Fatal(err)
	}
	reposFile := filepath.Join(home, "repositories.yaml")
	if err := os.WriteFile(reposFile, []byte(fmt.Sprintf("apiVersion: v1\nrepositories:\n- name: acme\n  url: %s\n", srv.URL)), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HELM_REPOSITORY_CONFIG", reposFile)
	t.Setenv("HELM_REPOSITORY_CACHE", cache)
	t.Setenv("HELM_CACHE_HOME", filepath.Join(home, "cache"))
	t.Setenv("HELM_CONFIG_HOME", filepath.Join(home, "config"))
	t.Setenv("HELM_DATA_HOME", filepath.Join(home, "data"))
	return srv.URL
}

func testChart(name, version, desc string) *chartv2.Chart {
	values := "replicas: 1\nmessage: hello\n"
	return &chartv2.Chart{
		Metadata: &chartv2.Metadata{APIVersion: "v2", Name: name, Version: version, AppVersion: "1.0", Description: desc},
		Values:   map[string]any{"replicas": 1, "message": "hello"},
		Raw:      []*common.File{{Name: "values.yaml", Data: []byte(values)}},
		Templates: []*common.File{
			{Name: "templates/cm.yaml", Data: []byte("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}-config\ndata:\n  message: {{ .Values.message | quote }}\n")},
			{Name: "templates/secret.yaml", Data: []byte("apiVersion: v1\nkind: Secret\nmetadata:\n  name: {{ .Release.Name }}-secret\nstringData:\n  password: hunter2\n")},
		},
	}
}

func TestHelmChartSearchAndDefaults(t *testing.T) {
	testChartRepo(t, testChart("grafana", "8.5.2", "Dashboards"), testChart("grafana", "8.4.0", "Dashboards"),
		testChart("agent", "0.42.0", "An agent for grafana"), testChart("redis", "20.0.0", "Key-value store"))
	got, err := HelmCharts("graf")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, c := range got.Charts {
		names = append(names, c.Repo+"/"+c.Name+"@"+c.Version)
	}
	// Name matches first, then description matches; the newest version is the entry's.
	if strings.Join(names, " ") != "acme/grafana@8.5.2 acme/agent@0.42.0" {
		t.Fatalf("search = %v", names)
	}
	if len(got.Charts[0].Versions) != 2 || got.Charts[0].Versions[1].Version != "8.4.0" {
		t.Fatalf("versions = %+v", got.Charts[0].Versions)
	}
	all, _ := HelmCharts("")
	if len(all.Charts) != 3 {
		t.Fatalf("all = %d", len(all.Charts))
	}
	defaults, err := HelmChartDefaults("acme", "grafana", "8.4.0")
	if err != nil {
		t.Fatal(err)
	}
	if defaults != "replicas: 1\nmessage: hello\n" {
		t.Fatalf("defaults = %q", defaults)
	}
	if _, err := HelmChartDefaults("nope", "grafana", ""); err == nil || !strings.Contains(err.Error(), `no Helm repository named "nope"`) {
		t.Fatalf("unknown repo err = %v", err)
	}
}

func TestHelmChartSearchWithoutRepositories(t *testing.T) {
	t.Setenv("HELM_REPOSITORY_CONFIG", filepath.Join(t.TempDir(), "none.yaml"))
	got, err := HelmCharts("x")
	if err != nil || len(got.Charts) != 0 || !strings.Contains(got.Note, "helm repo add") {
		t.Fatalf("got %+v, %v", got, err)
	}
}

func TestInstallValues(t *testing.T) {
	if v, err := parseInstallValues("  \n"); err != nil || len(v) != 0 {
		t.Fatalf("empty = %v %v", v, err)
	}
	if v, err := parseInstallValues("a:\n  b: 1\n"); err != nil || v["a"].(map[string]any)["b"] != float64(1) {
		t.Fatalf("values = %v %v", v, err)
	}
	if _, err := parseInstallValues("a: [1"); err == nil {
		t.Fatal("bad YAML accepted")
	}
	if err := (HelmInstallRequest{Cluster: "c", Namespace: "n", Name: "r", Repo: "acme"}).check(); err == nil {
		t.Fatal("a request without a chart passed")
	}
}
