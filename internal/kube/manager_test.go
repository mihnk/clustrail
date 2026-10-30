package kube

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestManagerListsContextsAndClassifiesFailures(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config")
	if err := os.WriteFile(cfg, []byte(`apiVersion: v1
kind: Config
clusters:
- name: eks
  cluster: {server: "https://127.0.0.1:1"}
users:
- name: tok
  user: {token: abc}
contexts:
- name: arn:aws:eks:eu-west-1:482100000000:cluster/prod-eu-west-1
  context: {cluster: eks, user: tok}
- name: dev-local
  context: {cluster: eks, user: tok}
`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KUBECONFIG", cfg)
	store, err := OpenStore(filepath.Join(dir, "contexts.json"))
	if err != nil {
		t.Fatal(err)
	}
	rec := &recorder{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := NewManager(ctx, store, rec)
	defer m.Shutdown()

	list := m.List()
	if len(list.Clusters) != 2 || len(list.Discovered) != 0 {
		t.Fatalf("list = %+v", list)
	}
	prod := list.Clusters[0]
	if prod.ID != "prod-eu-west-1" || prod.Env != EnvProd || !prod.Protected || prod.Context != "arn:aws:eks:eu-west-1:482100000000:cluster/prod-eu-west-1" {
		t.Fatalf("prod = %+v", prod)
	}

	if err := m.UpdateSettings("dev-local", EnvStg, false, true); err != nil {
		t.Fatal(err)
	}
	if cs, ok := store.Settings("dev-local", "dev-local"); !ok || cs.Env != EnvStg || !cs.ReadOnly {
		t.Fatalf("stored = %+v", cs)
	}

	m.Connect("prod-eu-west-1")
	waitFor(t, "connect to fail", func() bool {
		for _, c := range m.List().Clusters {
			if c.ID == "prod-eu-west-1" {
				return c.Connection == Unreachable && c.Error != ""
			}
		}
		return false
	})
	if _, err := m.conn("prod-eu-west-1"); err == nil {
		t.Fatal("a failed connect must not leave a connection")
	}

	if err := m.Hide("dev-local"); err != nil {
		t.Fatal(err)
	}
	if got := len(m.List().Clusters); got != 1 {
		t.Fatalf("after hide: %d clusters", got)
	}

	// A context added to the kubeconfig later shows up as discovered, never connected.
	time.Sleep(10 * time.Millisecond)
	raw, _ := os.ReadFile(cfg)
	raw = append(raw, []byte("- name: staging-eu-2\n  context: {cluster: eks, user: tok}\n")...)
	if err := os.WriteFile(cfg, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Minute)
	_ = os.Chtimes(cfg, future, future)
	waitFor(t, "kubeconfig reload", func() bool {
		d := m.List().Discovered
		return len(d) == 1 && d[0].ID == "staging-eu-2" && d[0].Connection == Disconnected
	})
}
