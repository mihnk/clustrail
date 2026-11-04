package kube

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func TestContextKubeconfigHoldsOnlyThatContext(t *testing.T) {
	merged := clientcmdapi.NewConfig()
	merged.Clusters["prod"] = &clientcmdapi.Cluster{Server: "https://prod:6443", CertificateAuthority: "/etc/ca-prod.crt"}
	merged.Clusters["dev"] = &clientcmdapi.Cluster{Server: "https://dev:6443"}
	merged.AuthInfos["prod-admin"] = &clientcmdapi.AuthInfo{Exec: &clientcmdapi.ExecConfig{Command: "aws", Args: []string{"eks", "get-token"}, APIVersion: "client.authentication.k8s.io/v1beta1"}}
	merged.AuthInfos["dev-user"] = &clientcmdapi.AuthInfo{Token: "dev-secret-token"}
	merged.Contexts["prod-eu"] = &clientcmdapi.Context{Cluster: "prod", AuthInfo: "prod-admin", Namespace: "payments"}
	merged.Contexts["dev"] = &clientcmdapi.Context{Cluster: "dev", AuthInfo: "dev-user"}
	merged.CurrentContext = "dev"

	raw, err := contextKubeconfig(merged, "prod-eu")
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := clientcmd.Load(raw)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CurrentContext != "prod-eu" || len(cfg.Contexts) != 1 || len(cfg.Clusters) != 1 || len(cfg.AuthInfos) != 1 {
		t.Fatalf("config = %+v", cfg)
	}
	if cfg.Contexts["prod-eu"].Namespace != "payments" || cfg.Clusters["prod"].CertificateAuthority != "/etc/ca-prod.crt" || cfg.AuthInfos["prod-admin"].Exec.Command != "aws" {
		t.Fatalf("context not kept as is: %+v", cfg)
	}
	if strings.Contains(string(raw), "dev-secret-token") {
		t.Fatal("another context's credentials were copied")
	}
	if _, err := contextKubeconfig(merged, "missing"); err == nil {
		t.Fatal("a missing context passed")
	}
}

func TestShellEnvReplacesKubeconfig(t *testing.T) {
	t.Setenv("KUBECONFIG", "/home/me/.kube/config:/home/me/other")
	env := shellEnv("/tmp/k")
	n := 0
	for _, kv := range env {
		if strings.HasPrefix(kv, "KUBECONFIG=") {
			n++
			if kv != "KUBECONFIG=/tmp/k" {
				t.Fatalf("KUBECONFIG = %q", kv)
			}
		}
	}
	if n != 1 {
		t.Fatalf("%d KUBECONFIG entries", n)
	}
}

type captureEmitter struct {
	mu  sync.Mutex
	out []ExecOutput
}

func (c *captureEmitter) Emit(name string, v any) {
	if o, ok := v.(ExecOutput); ok && name == EventExec {
		c.mu.Lock()
		c.out = append(c.out, o)
		c.mu.Unlock()
	}
}

func (c *captureEmitter) text() (string, *int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var b strings.Builder
	var exit *int
	for _, o := range c.out {
		d, _ := base64.StdEncoding.DecodeString(o.Data)
		b.Write(d)
		if o.Exit != nil {
			exit = o.Exit
		}
	}
	return b.String(), exit
}

// A real shell in a terminal: kubectl config would read the temporary file.
func TestLocalShellRunsWithTheContext(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell")
	}
	t.Setenv("SHELL", "/bin/sh")
	cache := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", cache)
	t.Setenv("HOME", cache)
	c, _, _ := newFakeConn(t)
	m := managerWith(c, false)
	em := &captureEmitter{}
	m.emit = em
	store, err := OpenStore(filepath.Join(cache, "contexts.json"))
	if err != nil {
		t.Fatal(err)
	}
	m.store = store
	m.streams = streams{logs: map[string]*logStream{}, exec: map[string]*execSession{}}
	// The test's own kubeconfig, whatever KUBECONFIG the machine running the
	// tests has: the manager reloads when the files it was built from change.
	kubeconfig := filepath.Join(cache, "kubeconfig")
	raw := "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {server: 'https://c:6443'}\nusers:\n- name: u\n  user: {token: t}\ncontexts:\n- name: ctx-a\n  context: {cluster: c, user: u}\n"
	if err := os.WriteFile(kubeconfig, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KUBECONFIG", kubeconfig)
	m.kc = LoadKubeconfig(nil)
	if m.kc.Changed(nil) {
		t.Fatal("a kubeconfig just loaded reads as changed")
	}
	m.state["test"].Context = "ctx-a"

	// A leftover from a crash is removed at the next start.
	_ = os.MkdirAll(localShellDir(), 0o700)
	stale := filepath.Join(localShellDir(), "kubeconfig-stale")
	_ = os.WriteFile(stale, []byte("x"), 0o600)

	info, err := m.StartLocalShell(LocalShellRequest{Cluster: "test", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	if info.Shell != "/bin/sh" || info.Context != "ctx-a" {
		t.Fatalf("info = %+v", info)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("stale kubeconfig kept")
	}
	// Markers the echoed input cannot contain: the typed text has the commands, not their results.
	if err := m.ExecInput(info.ID, "echo \"CTX=$(grep -c 'current-context: ctx-a' \"$KUBECONFIG\")\"; echo \"MODE=$(stat -c %a \"$KUBECONFIG\" 2>/dev/null || stat -f %Lp \"$KUBECONFIG\")\"; echo \"KC=$KUBECONFIG\"; exit 3\n"); err != nil {
		t.Fatal(err)
	}
	var out string
	var exit *int
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if out, exit = em.text(); exit != nil {
			break
		}
	}
	if exit == nil || *exit != 3 {
		t.Fatalf("exit = %v, output %q", exit, out)
	}
	if !strings.Contains(out, "CTX=1") {
		t.Fatalf("the shell did not see the context in $KUBECONFIG: %q", out)
	}
	if !strings.Contains(out, "MODE=600") {
		t.Fatalf("kubeconfig mode not 600: %q", out)
	}
	// $KUBECONFIG in the shell is the temporary file, not the test's (or the user's) own.
	if !strings.Contains(out, "KC="+localShellDir()+string(filepath.Separator)+"kubeconfig-") {
		t.Fatalf("$KUBECONFIG is not the temporary file under %s: %q", localShellDir(), out)
	}
	// The file is gone once the shell ended.
	entries, _ := os.ReadDir(localShellDir())
	if len(entries) != 0 {
		t.Fatalf("kubeconfig left behind: %v", entries)
	}
}

func TestLocalShellRefusedOnReadOnly(t *testing.T) {
	c, _, _ := newFakeConn(t)
	m := managerWith(c, true)
	if _, err := m.StartLocalShell(LocalShellRequest{Cluster: "test"}); err != ErrReadOnly {
		t.Fatalf("err = %v", err)
	}
	if _, err := m.StartAttach(ExecRequest{Cluster: "test"}); err != ErrReadOnly {
		t.Fatalf("attach err = %v", err)
	}
}
