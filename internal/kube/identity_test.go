package kube

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// writeContexts writes a kubeconfig with the given contexts → servers.
func writeContexts(t *testing.T, path string, contexts map[string]string) {
	t.Helper()
	raw := "apiVersion: v1\nkind: Config\nusers:\n- name: u\n  user: {token: t}\nclusters:\n"
	i := 0
	names := map[string]string{}
	for ctx, server := range contexts {
		names[ctx] = fmt.Sprintf("c%d", i)
		raw += fmt.Sprintf("- name: c%d\n  cluster: {server: %q}\n", i, server)
		i++
	}
	raw += "contexts:\n"
	for ctx := range contexts {
		raw += fmt.Sprintf("- name: %s\n  context: {cluster: %s, user: u}\n", ctx, names[ctx])
	}
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
}

func identityManager(t *testing.T, contexts map[string]string) (*Manager, *Store, string, *recorder) {
	t.Helper()
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config")
	writeContexts(t, cfg, contexts)
	t.Setenv("KUBECONFIG", cfg)
	store, err := OpenStore(filepath.Join(dir, "contexts.json"))
	if err != nil {
		t.Fatal(err)
	}
	_ = store.MarkKnown(nil) // past the first run: new contexts are new
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rec := &recorder{}
	m := NewManager(ctx, store, rec)
	t.Cleanup(m.Shutdown)
	return m, store, cfg, rec
}

// A production context renamed in the kubeconfig keeps its environment and
// protection under the new name, and the user is told.
func TestARenamedContextKeepsItsSettings(t *testing.T) {
	m, store, cfg, rec := identityManager(t, map[string]string{"payments-prod": "https://10.1.0.1:6443"})
	if err := store.SetSettings("payments-prod", ContextSettings{Env: EnvProd, Protected: true, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	writeContexts(t, cfg, map[string]string{"eks-payments": "https://10.1.0.1:6443"})
	m.reload()
	st := stateOf(m, "eks-payments")
	if st.Env != EnvProd || !st.Protected || !st.ReadOnly {
		t.Fatalf("renamed context = env %s, protected %v, read-only %v", st.Env, st.Protected, st.ReadOnly)
	}
	if n := rec.notices(); len(n) != 1 || n[0].Title != "Settings carried over to eks-payments" {
		t.Fatalf("notices = %+v", n)
	}
	// A new context on another server is new: nothing carried over.
	writeContexts(t, cfg, map[string]string{"eks-payments": "https://10.1.0.1:6443", "dev-sandbox": "https://10.9.0.1:6443"})
	m.reload()
	if st := stateOf(m, "dev-sandbox"); st.Protected || st.ReadOnly {
		t.Fatalf("an unrelated context took settings: %+v", st)
	}
}

// Two gone contexts on one server: the strictest settings win.
func TestCarryOverTakesTheStrictest(t *testing.T) {
	dir := t.TempDir()
	store, _ := OpenStore(filepath.Join(dir, "s.json"))
	_ = store.RecordServers(map[string]string{"a": "https://x", "b": "https://x"})
	_ = store.SetSettings("a", ContextSettings{Env: EnvDev})
	_ = store.SetSettings("b", ContextSettings{Env: EnvProd, Protected: true})
	r := store.CarryOverRenamed(map[string]string{"c": "https://x"})
	if len(r) != 1 || r[0].To != "c" || r[0].From != "a, b" {
		t.Fatalf("renames = %+v", r)
	}
	if cs, _ := store.Settings("c", "c"); cs.Env != EnvProd || !cs.Protected {
		t.Fatalf("carried = %+v", cs)
	}
}

// Protection follows the server: a second context name for a protected
// cluster cannot be used to skip the typed confirmation.
func TestProtectionFollowsTheServer(t *testing.T) {
	m, store, _, _ := identityManager(t, map[string]string{"prod-admin": "https://10.2.0.1:6443", "prod-readonly-alias": "https://10.2.0.1:6443", "staging": "https://10.3.0.1:6443"})
	_ = store.SetSettings("prod-admin", ContextSettings{Env: EnvProd, Protected: true})
	_ = store.SetSettings("prod-readonly-alias", ContextSettings{Env: EnvDev})
	_ = store.SetSettings("staging", ContextSettings{Env: EnvStg})
	m.reload()
	if st := stateOf(m, "prod-readonly-alias"); !st.Protected || st.ProtectedBy != "prod-admin" {
		t.Fatalf("alias = protected %v by %q", st.Protected, st.ProtectedBy)
	}
	if st := stateOf(m, "prod-admin"); st.ProtectedBy != "" {
		t.Fatal("the protected context itself names no other")
	}
	if st := stateOf(m, "staging"); st.Protected {
		t.Fatal("another server is not affected")
	}
}
