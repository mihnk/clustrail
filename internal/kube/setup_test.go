package kube

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const setupKubeconfig = `apiVersion: v1
kind: Config
current-context: prod-eu-west-1
clusters:
- name: eks
  cluster: {server: "https://127.0.0.1:1"}
- name: acme
  cluster: {server: "https://k8s.acme.internal:6443"}
users:
- name: tok
  user: {token: abc}
contexts:
- name: prod-eu-west-1
  context: {cluster: eks, user: tok}
- name: acme-main
  context: {cluster: acme, user: tok}
- name: kind-local
  context: {cluster: eks, user: tok}
`

func setupManager(t *testing.T) (*Manager, *Store, string) {
	t.Helper()
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config")
	if err := os.WriteFile(cfg, []byte(setupKubeconfig), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KUBECONFIG", cfg)
	t.Setenv("HOME", dir)
	store, err := OpenStore(filepath.Join(dir, "contexts.json"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m := NewManager(ctx, store, &recorder{})
	t.Cleanup(m.Shutdown)
	return m, store, dir
}

func TestSuggestEnv(t *testing.T) {
	for _, c := range []struct {
		context, cluster, server string
		env                      Environment
		word, field              string
	}{
		{"prod-eu-west-1", "", "", EnvProd, "prod", "context"},
		{"payments-preprod", "", "", EnvStg, "preprod", "context"},
		{"kind-local", "", "", EnvDev, "local", "context"},
		{"acme-main", "gke_acme_staging-1", "", EnvStg, "staging", "cluster"},
		{"acme-main", "acme", "https://127.0.0.1:6443", EnvDev, "127.0.0.1", "server"},
		{"acme-main", "acme", "https://k8s.acme.internal:6443", "", "", ""},
	} {
		env, hint := SuggestEnv(c.context, c.cluster, c.server)
		if env != c.env || (hint == nil) != (c.word == "") || (hint != nil && (hint.Word != c.word || hint.Field != c.field)) {
			t.Errorf("SuggestEnv(%q, %q, %q) = %q %+v", c.context, c.cluster, c.server, env, hint)
		}
	}
}

func TestSetupOnlyForFreshInstalls(t *testing.T) {
	dir := t.TempDir()
	fresh, _ := OpenStore(filepath.Join(dir, "a.json"))
	if fresh.SetupDone() {
		t.Fatal("a fresh install must start with setup")
	}
	// A settings file from before setup existed: its user is past it.
	old := filepath.Join(dir, "b.json")
	if err := os.WriteFile(old, []byte(`{"contexts":{},"known":["x"],"firstRunDone":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	existing, err := OpenStore(old)
	if err != nil {
		t.Fatal(err)
	}
	if !existing.SetupDone() {
		t.Fatal("existing users must not see setup")
	}
	// Quitting halfway: setup is still due on the next start.
	_ = fresh.MarkKnown([]string{"x"})
	again, _ := OpenStore(filepath.Join(dir, "a.json"))
	if again.SetupDone() {
		t.Fatal("setup not finished must still be due")
	}
}

func TestSetupFlow(t *testing.T) {
	m, store, dir := setupManager(t)
	// A fresh install has no selection yet: an empty list, never null in JSON.
	if raw, _ := json.Marshal(m.List().Selected); string(raw) != "[]" {
		t.Fatalf("selected = %s", raw)
	}
	info := m.Setup()
	if !info.Needed || len(info.Contexts) != 3 {
		t.Fatalf("setup = %+v", info)
	}
	byName := map[string]SetupContext{}
	for _, c := range info.Contexts {
		byName[c.Name] = c
	}
	if c := byName["prod-eu-west-1"]; c.Env != EnvProd || !c.Protected || !c.Current || c.Hint == nil {
		t.Fatalf("prod = %+v", c)
	}
	if c := byName["acme-main"]; c.Env != "" || c.Hint != nil {
		t.Fatalf("acme-main needs a choice: %+v", c)
	}
	if len(info.Locations) == 0 || info.Locations[0].State != "found" || info.Locations[0].Contexts != 3 {
		t.Fatalf("locations = %+v", info.Locations)
	}

	if err := m.CompleteSetup([]SetupChoice{{ID: "acme-main"}}, nil); err == nil {
		t.Fatal("a context without an environment must be refused")
	}
	err := m.CompleteSetup([]SetupChoice{
		{ID: "prod-eu-west-1", Env: EnvProd, Protected: true},
		{ID: "acme-main", Env: EnvProd, ReadOnly: true},
	}, []string{"prod-eu-west-1"})
	if err != nil {
		t.Fatal(err)
	}
	if m.Setup().Needed {
		t.Fatal("setup still needed after completing it")
	}
	if cs, _ := store.Settings("acme-main", "acme-main"); !cs.ReadOnly || !cs.Protected || cs.Env != EnvProd {
		t.Fatalf("acme-main = %+v", cs)
	}
	list := m.List()
	if len(list.Clusters) != 2 || len(list.Discovered) != 1 || list.Discovered[0].ID != "kind-local" {
		t.Fatalf("left-out contexts must be available, not gone: %+v / %+v", list.Clusters, list.Discovered)
	}
	if len(list.Selected) != 1 || list.Selected[0] != "prod-eu-west-1" {
		t.Fatalf("selected = %v", list.Selected)
	}
	if err := m.RestartSetup(); err != nil || !m.Setup().Needed {
		t.Fatal("setup could not be run again")
	}

	// The kubeconfig file itself is never written.
	raw, _ := os.ReadFile(filepath.Join(dir, "config"))
	if string(raw) != setupKubeconfig {
		t.Fatal("kubeconfig was modified")
	}
}

func TestPasteKubeconfig(t *testing.T) {
	m, _, dir := setupManager(t)
	if _, err := m.PasteKubeconfig("not: [yaml"); err == nil {
		t.Fatal("invalid text accepted")
	}
	pasted := `apiVersion: v1
kind: Config
clusters: [{name: c, cluster: {server: "https://10.0.0.1"}}]
users: [{name: u, user: {token: t}}]
contexts: [{name: pasted-dev, context: {cluster: c, user: u}}]
`
	first, err := m.PasteKubeconfig(pasted)
	if err != nil {
		t.Fatal(err)
	}
	second, err := m.PasteKubeconfig(pasted)
	if err != nil || first == second {
		t.Fatalf("second paste %q (%v) must not overwrite %q", second, err, first)
	}
	st, err := os.Stat(filepath.Join(dir, ".kube", "clustrail-pasted.yaml"))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("pasted file: %v %v", st, err)
	}
	found := false
	for _, c := range m.Setup().Contexts {
		found = found || c.Name == "pasted-dev"
	}
	if !found {
		t.Fatal("pasted context not loaded")
	}
}
