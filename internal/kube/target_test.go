package kube

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeKubeconfig(t *testing.T, path, server, token string) {
	t.Helper()
	raw := fmt.Sprintf(`apiVersion: v1
kind: Config
clusters:
- name: c
  cluster: {server: %q}
users:
- name: u
  user: {token: %q}
contexts:
- name: dev-local
  context: {cluster: c, user: u, namespace: payments}
`, server, token)
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	// Polling compares modification times: make every write visible.
	future := time.Now().Add(time.Duration(time.Now().UnixNano()%1000+1) * time.Second)
	_ = os.Chtimes(path, future, future)
}

func (r *recorder) notices() []Notice {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []Notice
	for _, e := range r.events {
		if n, ok := e.data.(Notice); ok {
			out = append(out, n)
		}
	}
	return out
}

// fakeConnected registers a fake connection for dev-local built from the current kubeconfig.
func fakeConnected(t *testing.T, m *Manager) *clusterConn {
	t.Helper()
	c, _, _ := newFakeConn(t)
	c.ctx = context.Background()
	m.mu.Lock()
	c.fingerprint, _ = contextFingerprint(m.kc.Merged, "dev-local")
	m.conns["dev-local"] = c
	m.mu.Unlock()
	return c
}

func stateOf(m *Manager, id string) Cluster {
	m.mu.Lock()
	defer m.mu.Unlock()
	return *m.state[id]
}

func TestKubeconfigChangesReconnectOrLockChanges(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config")
	writeKubeconfig(t, cfg, "https://10.0.0.1:6443", "token-1")
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
	if store.ConfirmedServer("dev-local") != "https://10.0.0.1:6443" {
		t.Fatal("the first server seen is recorded as confirmed")
	}

	// Nothing changed: the connection stays.
	conn := fakeConnected(t, m)
	m.reload()
	if c, _ := m.conn("dev-local"); c != conn {
		t.Fatal("an unchanged kubeconfig keeps the connection")
	}
	if _, err := m.writable("dev-local"); err != nil {
		t.Fatal(err)
	}

	// New credentials, same server: reconnect, nothing locked.
	writeKubeconfig(t, cfg, "https://10.0.0.1:6443", "token-2")
	m.reload()
	if c, _ := m.conn("dev-local"); c == conn {
		t.Fatal("a connection built with old credentials must be replaced")
	}
	if st := stateOf(m, "dev-local"); st.TargetChanged != nil || st.Connection != Connecting {
		t.Fatalf("after a credentials change = %+v", st)
	}
	if n := rec.notices(); len(n) != 1 || n[0].Title != "Reconnected dev-local" {
		t.Fatalf("notices = %+v", n)
	}
	m.Disconnect("dev-local")

	// Another server: disconnected, not reconnected, changes locked. The change
	// is caught by the next action even before the 3 s poll reloads.
	conn = fakeConnected(t, m)
	writeKubeconfig(t, cfg, "https://10.9.9.9:6443", "token-2")
	if _, err := m.writable("dev-local"); !errors.Is(err, ErrTargetChanged) {
		t.Fatalf("writable after a server change = %v", err)
	}
	if c, _ := m.conn("dev-local"); c != nil {
		t.Fatal("the connection to the old server must be closed")
	}
	st := stateOf(m, "dev-local")
	if st.TargetChanged == nil || st.TargetChanged.From != "https://10.0.0.1:6443" || st.TargetChanged.To != "https://10.9.9.9:6443" || st.Connection != Disconnected {
		t.Fatalf("after a server change = %+v (%+v)", st, st.TargetChanged)
	}
	if n := rec.notices(); n[len(n)-1].Title != "dev-local points to another server" {
		t.Fatalf("notices = %+v", n)
	}
	// Reading still works once connected again; changes stay locked.
	fakeConnected(t, m)
	if _, err := m.conn("dev-local"); err != nil {
		t.Fatal(err)
	}
	if err := m.DeletePod("dev-local", "payments", "a", ""); !errors.Is(err, ErrTargetChanged) {
		t.Fatalf("delete while locked = %v", err)
	}

	if err := m.ConfirmTarget("dev-local"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.writable("dev-local"); err != nil {
		t.Fatalf("after confirming = %v", err)
	}
	if store.ConfirmedServer("dev-local") != "https://10.9.9.9:6443" {
		t.Fatal("the confirmed server is stored")
	}

	// The kubeconfig changes while Clustrail is closed: caught at start.
	m.Shutdown()
	writeKubeconfig(t, cfg, "https://10.7.7.7:6443", "token-2")
	m2 := NewManager(ctx, store, &recorder{})
	defer m2.Shutdown()
	if st := stateOf(m2, "dev-local"); st.TargetChanged == nil || st.TargetChanged.From != "https://10.9.9.9:6443" {
		t.Fatalf("after restart = %+v", st.TargetChanged)
	}
}

func TestDisconnectCancelsAConnectInFlight(t *testing.T) {
	// An API server that never answers: the probe hangs until cancelled.
	hang := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-hang:
		}
	}))
	defer srv.Close()
	defer close(hang)

	dir := t.TempDir()
	cfg := filepath.Join(dir, "config")
	writeKubeconfig(t, cfg, srv.URL, "t")
	t.Setenv("KUBECONFIG", cfg)
	store, _ := OpenStore(filepath.Join(dir, "contexts.json"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := NewManager(ctx, store, &recorder{})
	defer m.Shutdown()

	m.Connect("dev-local")
	m.Connect("dev-local") // a second click while connecting starts nothing new
	m.mu.Lock()
	pending := len(m.pending)
	m.mu.Unlock()
	if pending != 1 || stateOf(m, "dev-local").Connection != Connecting {
		t.Fatalf("pending = %d, state = %s", pending, stateOf(m, "dev-local").Connection)
	}
	time.Sleep(100 * time.Millisecond)
	m.Disconnect("dev-local")
	// The cancelled attempt neither registers a connection nor overwrites the state.
	time.Sleep(300 * time.Millisecond)
	if c, _ := m.conn("dev-local"); c != nil {
		t.Fatal("a disconnected attempt must not register a connection")
	}
	m.mu.Lock()
	pending = len(m.pending)
	m.mu.Unlock()
	if st := stateOf(m, "dev-local"); st.Connection != Disconnected || st.Error != "" || pending != 0 {
		t.Fatalf("after disconnect = %s %q pending=%d", st.Connection, st.Error, pending)
	}
}
