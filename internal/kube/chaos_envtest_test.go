//go:build envtest

package kube

// Chaos tests against a real kube-apiserver and etcd (issue D4). Each case
// breaks the path to the API server, then checks that the connection says
// so (never a stale "connected") and that, once healed, the rows equal the
// API server's.
//
//	KUBEBUILDER_ASSETS=/path/to/envtest/bin go test -tags envtest -run TestChaos -v ./internal/kube

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// Proxy modes.
const (
	pass      int32 = iota
	hang            // requests are accepted and never answered
	partition       // connections are dropped
	expired         // every request is refused as unauthenticated
)

// chaosProxy stands between Clustrail and the API server and breaks the path on demand.
type chaosProxy struct {
	*httptest.Server
	mode atomic.Int32
}

func newChaosProxy(t *testing.T, target string) *chaosProxy {
	u, _ := url.Parse(target)
	rp := httputil.NewSingleHostReverseProxy(u)
	rp.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}} //nolint:gosec // a local test API server
	rp.FlushInterval = -1                                                                  // watches stream
	p := &chaosProxy{}
	p.Server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch p.mode.Load() {
		case hang:
			<-r.Context().Done()
			return
		case partition:
			if hj, ok := w.(http.Hijacker); ok {
				if conn, _, err := hj.Hijack(); err == nil {
					_ = conn.Close()
				}
			}
			return
		case expired:
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","message":"Unauthorized","reason":"Unauthorized","code":401}`))
			return
		}
		rp.ServeHTTP(w, r)
	}))
	t.Cleanup(p.Close)
	return p
}

// set changes the mode and cuts the connections already open (watches).
func (p *chaosProxy) set(mode int32) {
	p.mode.Store(mode)
	if mode != pass {
		p.CloseClientConnections()
	}
}

// chaosTiming shortens probes and deadlines for the envtest binary. They are
// not restored: probe loops of managers that are shutting down still read
// them, and only envtest tests run in this binary.
func chaosTiming(*testing.T) {
	chaosTimingOnce.Do(func() {
		probeInterval, probeTimeout, requestDeadline, headerDeadline = 500*time.Millisecond, time.Second, 5*time.Second, 3*time.Second
	})
}

var chaosTimingOnce sync.Once

func adminClient(t *testing.T, host string) kubernetes.Interface {
	c, err := kubernetes.NewForConfig(&rest.Config{Host: host, BearerToken: "admintoken", TLSClientConfig: rest.TLSClientConfig{Insecure: true}, QPS: 500, Burst: 1000})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// discard drops events: a soak must not measure a test recorder's growth.
type discard struct{}

func (discard) Emit(string, any) {}

// chaosManager connects a manager to server (the proxy or the API server).
func chaosManager(t *testing.T, server string) *Manager {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config")
	raw := fmt.Sprintf("apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {server: %q, insecure-skip-tls-verify: true}\nusers:\n- name: u\n  user: {token: admintoken}\ncontexts:\n- name: envtest\n  context: {cluster: c, user: u}\n", server)
	if err := os.WriteFile(cfg, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KUBECONFIG", cfg)
	store, err := OpenStore(filepath.Join(dir, "contexts.json"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m := NewManager(ctx, store, discard{})
	t.Cleanup(m.Shutdown)
	m.Connect("envtest")
	waitConnection(t, m, 60*time.Second, Connected)
	return m
}

func waitConnection(t *testing.T, m *Manager, within time.Duration, want ...ConnectionState) Cluster {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		c := m.List().Clusters[0]
		for _, w := range want {
			if c.Connection == w {
				return c
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("connection is %s (%s), want %v", c.Connection, c.Error, want)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// podNames of the namespace as Clustrail shows them and as the API server has them.
func shownPods(m *Manager, ns string) []string {
	var out []string
	for _, p := range m.Snapshot().Pods {
		if p.Namespace == ns {
			out = append(out, p.Name)
		}
	}
	sort.Strings(out)
	return out
}

func sourcePods(t *testing.T, c kubernetes.Interface, ns string) []string {
	l, err := c.CoreV1().Pods(ns).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, p := range l.Items {
		out = append(out, p.Name)
	}
	sort.Strings(out)
	return out
}

func waitSameRows(t *testing.T, m *Manager, c kubernetes.Interface, ns string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		shown, src := shownPods(m, ns), sourcePods(t, c, ns)
		if strings.Join(shown, ",") == strings.Join(src, ",") {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("rows differ from the API server:\nshown  %v\nsource %v", shown, src)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func makePods(t *testing.T, c kubernetes.Interface, ns, prefix string, n int) {
	t.Helper()
	ctx := context.Background()
	_, _ = c.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}, metav1.CreateOptions{})
	for i := range n {
		p := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("%s-%d", prefix, i), Namespace: ns},
			Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "example/app:1"}}}}
		if _, err := c.CoreV1().Pods(ns).Create(ctx, p, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
}

func deletePods(t *testing.T, c kubernetes.Interface, ns, prefix string, n int) {
	t.Helper()
	zero := int64(0)
	for i := range n {
		_ = c.CoreV1().Pods(ns).Delete(context.Background(), fmt.Sprintf("%s-%d", prefix, i), metav1.DeleteOptions{GracePeriodSeconds: &zero})
	}
}

func envtestBins(t *testing.T) string {
	bins := os.Getenv("KUBEBUILDER_ASSETS")
	if bins == "" {
		t.Skip("set KUBEBUILDER_ASSETS to the envtest binaries")
	}
	return bins
}

func TestChaos(t *testing.T) {
	bins := envtestBins(t)
	chaosTiming(t)
	// Compaction every second: a watch resumed after a few seconds away gets 410 Gone.
	env := startEnvCluster(t, bins, "--etcd-compaction-interval=1s")
	admin := adminClient(t, env.host)
	makePods(t, admin, "team", "base", 20)

	t.Run("network partition, then 410 Gone on resume", func(t *testing.T) {
		p := newChaosProxy(t, env.host)
		m := chaosManager(t, p.URL)
		waitSameRows(t, m, admin, "team")
		p.set(partition)
		c := waitConnection(t, m, 10*time.Second, Reconnecting)
		if c.Stale == nil {
			t.Fatal("a lost connection marks its rows stale")
		}
		// Changes while cut off, then compaction: the old watch position is gone.
		makePods(t, admin, "team", "during-partition", 5)
		deletePods(t, admin, "team", "base", 5)
		time.Sleep(3 * time.Second)
		p.set(pass)
		waitConnection(t, m, 30*time.Second, Connected)
		waitSameRows(t, m, admin, "team")
	})

	t.Run("requests that hang", func(t *testing.T) {
		p := newChaosProxy(t, env.host)
		m := chaosManager(t, p.URL)
		p.set(hang)
		// The probe ends at its deadline: a server that never answers is not connected.
		waitConnection(t, m, 10*time.Second, Reconnecting)
		makePods(t, admin, "team", "during-hang", 3)
		p.set(pass)
		waitConnection(t, m, 30*time.Second, Connected)
		waitSameRows(t, m, admin, "team")
	})

	t.Run("expired credentials, then renewed", func(t *testing.T) {
		p := newChaosProxy(t, env.host)
		m := chaosManager(t, p.URL)
		p.set(expired)
		waitConnection(t, m, 10*time.Second, AuthExpired)
		p.set(pass) // an exec plugin got a new token
		waitConnection(t, m, 30*time.Second, Connected)
		waitSameRows(t, m, admin, "team")
	})

	t.Run("API server restart", func(t *testing.T) {
		m := chaosManager(t, env.host)
		waitSameRows(t, m, admin, "team")
		env.stopAPI()
		waitConnection(t, m, 10*time.Second, Reconnecting)
		env.startAPI()
		makePods(t, admin, "team", "after-restart", 3)
		waitConnection(t, m, 60*time.Second, Connected)
		waitSameRows(t, m, admin, "team")
	})
}
