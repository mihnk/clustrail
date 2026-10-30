package kube

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	k8stesting "k8s.io/client-go/testing"
)

func TestConnectedOnlyWhenWatchesCaughtUp(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config")
	writeKubeconfig(t, cfg, "https://10.0.0.1:6443", "t")
	t.Setenv("KUBECONFIG", cfg)
	store, _ := OpenStore(filepath.Join(dir, "contexts.json"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := NewManager(ctx, store, &recorder{})
	defer m.Shutdown()
	c := fakeConnected(t, m)
	m.setState("dev-local", func(s *Cluster) { s.Connection, s.Stale = Reconnecting, &Stale{Since: 1} })
	caughtUp := false
	c.health.fail("watch-pods", func() bool { return caughtUp })

	m.onProbe("dev-local", 12, nil)
	st := stateOf(m, "dev-local")
	if st.Connection != Reconnecting || st.Stale == nil || !strings.Contains(st.Error, "1 watches are catching up") {
		t.Fatalf("API answers, watch behind = %+v", st)
	}
	caughtUp = true
	m.onProbe("dev-local", 12, nil)
	if st := stateOf(m, "dev-local"); st.Connection != Connected || st.Stale != nil || st.Error != "" {
		t.Fatalf("after catching up = %+v", st)
	}
	// A failed poll stays behind until a list succeeds.
	c.health.fail("poll-x", nil)
	if c.health.behind() != 1 {
		t.Fatal("poll failure must count")
	}
	c.health.ok("poll-x")
	if c.health.behind() != 0 {
		t.Fatal("a successful list clears it")
	}
}

func TestRowBatchKeepsTheLastEventPerObject(t *testing.T) {
	b := newRowBatch()
	b.upsert(GenericRow{ID: "a", Cells: []string{"v1"}})
	b.upsert(GenericRow{ID: "b"})
	b.delete("a") // updated then deleted in the same batch: only the delete
	b.delete("c") // deleted then recreated: only the upsert
	b.upsert(GenericRow{ID: "c", Cells: []string{"new"}})
	b.upsert(GenericRow{ID: "b", Cells: []string{"v2"}}) // two updates: the last
	ups, dels := b.take()
	if len(dels) != 1 || dels[0] != "a" {
		t.Fatalf("deletes = %v", dels)
	}
	if len(ups) != 2 || ups[0].ID != "b" || ups[0].Cells[0] != "v2" || ups[1].ID != "c" {
		t.Fatalf("upserts = %+v", ups)
	}
	if !b.empty() {
		t.Fatal("take starts a new batch")
	}
}

func TestHelmRevisionManifestHidesSecrets(t *testing.T) {
	masked := maskSecretsInManifest(manifestV1)
	if strings.Contains(masked, "aHVudGVyMg") || strings.Contains(masked, "ZXU=") {
		t.Fatalf("secret value leaked:\n%s", masked)
	}
	if !strings.Contains(masked, "# Source: w/templates/secret.yaml") || !strings.Contains(masked, "DB_PASSWORD: (hidden, 7 bytes)") {
		t.Fatalf("masked manifest:\n%s", masked)
	}
	// Other documents are untouched.
	if !strings.Contains(masked, "replicas: 3") || !strings.Contains(masked, "kind: ServiceMonitor") {
		t.Fatalf("other documents changed:\n%s", masked)
	}
}

func TestNodeShellStaysTrackedUntilDeleted(t *testing.T) {
	defer func(d time.Duration) { nodeShellRetry = d }(nodeShellRetry)
	nodeShellRetry = time.Millisecond
	shell := pod("clustrail-node-shell-n1-abcde", nil)
	c, client, _ := newFakeConn(t, shell)
	c.ctx = context.Background()
	m := managerWith(c, false)
	m.shells.pods = map[string]NodeShell{"test/payments/" + shell.Name: {Namespace: "payments", Pod: shell.Name}}
	failures := 2
	client.PrependReactor("delete", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		if failures > 0 {
			failures--
			return true, nil, errors.New("connection reset by peer")
		}
		return false, nil, nil
	})
	if err := m.DeleteNodeShell("test", "payments", shell.Name); err == nil {
		t.Fatal("a failed delete must be reported")
	}
	if len(m.shells.pods) != 1 {
		t.Fatal("a pod that was not deleted stays tracked")
	}
	// At quit, cleanup tries again until the pod is gone.
	m.CleanupNodeShells()
	if len(m.shells.pods) != 0 {
		t.Fatalf("still tracked: %v", m.shells.pods)
	}
	if _, err := client.CoreV1().Pods("payments").Get(context.Background(), shell.Name, metav1.GetOptions{}); err == nil {
		t.Fatal("the privileged pod must be gone")
	}
}
