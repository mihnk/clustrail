//go:build envtest

package kube

// Measures what a connected cluster costs while nothing changes: the
// backend's loop wakeups, its CPU time and context switches, against a real
// kube-apiserver and etcd (envtest binaries, no kubelet). A measurement, not
// a pass/fail test:
//
//	KUBEBUILDER_ASSETS=/path/to/envtest/bin IDLE_PODS=2000 IDLE_SECONDS=60 \
//	  go test -tags envtest -run TestIdleConnectedCluster -v ./internal/kube
//
// (setup-envtest prints KUBEBUILDER_ASSETS; IDLE_OUT=file.json writes the result.)

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/mihnk/clustrail/internal/diagnostics"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

func envInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v > 0 {
		return v
	}
	return def
}

func freeTCPPort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// startEnvtest starts etcd and kube-apiserver with a static admin token.
func startEnvtest(t *testing.T, bins string) string {
	dir := t.TempDir()
	cport, pport, aport := freeTCPPort(t), freeTCPPort(t), freeTCPPort(t)
	etcd := exec.Command(filepath.Join(bins, "etcd"), "--data-dir", filepath.Join(dir, "etcd"),
		"--listen-client-urls", fmt.Sprintf("http://127.0.0.1:%d", cport), "--advertise-client-urls", fmt.Sprintf("http://127.0.0.1:%d", cport),
		"--listen-peer-urls", fmt.Sprintf("http://127.0.0.1:%d", pport), "--initial-advertise-peer-urls", fmt.Sprintf("http://127.0.0.1:%d", pport),
		"--initial-cluster", fmt.Sprintf("default=http://127.0.0.1:%d", pport))
	if err := etcd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = etcd.Process.Kill(); _ = etcd.Wait() })
	if err := os.WriteFile(filepath.Join(dir, "tokens.csv"), []byte("admintoken,admin,admin-uid,\"system:masters\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pub, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	_ = os.WriteFile(filepath.Join(dir, "sa.key"), pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "sa.pub"), pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pub}), 0o600)
	api := exec.Command(filepath.Join(bins, "kube-apiserver"),
		"--etcd-servers", fmt.Sprintf("http://127.0.0.1:%d", cport),
		"--cert-dir", filepath.Join(dir, "certs"), "--secure-port", strconv.Itoa(aport), "--bind-address", "127.0.0.1",
		"--authorization-mode=RBAC", "--token-auth-file", filepath.Join(dir, "tokens.csv"),
		"--service-account-issuer", "https://kubernetes.default.svc", "--service-cluster-ip-range", "10.0.0.0/24",
		"--service-account-key-file", filepath.Join(dir, "sa.pub"), "--service-account-signing-key-file", filepath.Join(dir, "sa.key"),
		"--disable-admission-plugins=ServiceAccount")
	log, _ := os.Create(filepath.Join(dir, "apiserver.log"))
	api.Stdout, api.Stderr = log, log
	if err := api.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = api.Process.Kill(); _ = api.Wait() })
	host := fmt.Sprintf("https://127.0.0.1:%d", aport)
	hc := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}, Timeout: 2 * time.Second}
	for deadline := time.Now().Add(90 * time.Second); time.Now().Before(deadline); time.Sleep(300 * time.Millisecond) {
		req, _ := http.NewRequest(http.MethodGet, host+"/readyz", nil)
		req.Header.Set("Authorization", "Bearer admintoken")
		if r, err := hc.Do(req); err == nil {
			r.Body.Close()
			if r.StatusCode == http.StatusOK {
				return host
			}
		}
	}
	t.Fatal("kube-apiserver did not become ready")
	return ""
}

func TestIdleConnectedCluster(t *testing.T) {
	bins := os.Getenv("KUBEBUILDER_ASSETS")
	if bins == "" {
		t.Skip("set KUBEBUILDER_ASSETS to the envtest binaries")
	}
	pods, seconds := envInt("IDLE_PODS", 2000), envInt("IDLE_SECONDS", 30)
	host := startEnvtest(t, bins)

	// Pods across a few namespaces; no kubelet, so they stay Pending and never change.
	client, err := kubernetes.NewForConfig(&rest.Config{Host: host, BearerToken: "admintoken", TLSClientConfig: rest.TLSClientConfig{Insecure: true}, QPS: 500, Burst: 1000})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for i := range 5 {
		_, _ = client.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("team-%d", i)}}, metav1.CreateOptions{})
	}
	for i := range pods {
		p := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("app-%05d", i), Namespace: fmt.Sprintf("team-%d", i%5), Labels: map[string]string{"app": fmt.Sprintf("app-%d", i%50)}},
			Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "example/app:1"}}}}
		if _, err := client.CoreV1().Pods(p.Namespace).Create(ctx, p, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}

	dir := t.TempDir()
	cfg := filepath.Join(dir, "config")
	raw := fmt.Sprintf("apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {server: %q, insecure-skip-tls-verify: true}\nusers:\n- name: u\n  user: {token: admintoken}\ncontexts:\n- name: envtest\n  context: {cluster: c, user: u}\n", host)
	if err := os.WriteFile(cfg, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KUBECONFIG", cfg)
	store, _ := OpenStore(filepath.Join(dir, "contexts.json"))
	mctx, cancel := context.WithCancel(ctx)
	defer cancel()
	m := NewManager(mctx, store, &recorder{})
	defer m.Shutdown()
	m.Connect("envtest")
	for deadline := time.Now().Add(60 * time.Second); ; time.Sleep(200 * time.Millisecond) {
		if m.List().Clusters[0].Connection == Connected {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("not connected: %+v", m.List().Clusters[0])
		}
	}
	time.Sleep(5 * time.Second) // initial lists and the first flush settle

	w0, p0, at0 := Wakeups(), diagnostics.Sample(), time.Now()
	time.Sleep(time.Duration(seconds) * time.Second)
	w1, p1, at1 := Wakeups(), diagnostics.Sample(), time.Now()
	sec := at1.Sub(at0).Seconds()
	loops := map[string]float64{}
	for k, v := range w1 {
		if d := float64(v - w0[k]); d > 0 {
			loops[k] = d / sec
		}
	}
	res := map[string]any{
		"pods": pods, "seconds": sec,
		"cpuPercent":        (p1.CPUTimeMs - p0.CPUTimeMs) / sec / 10,
		"wakeupsPerSec":     float64(p1.VoluntarySwitches-p0.VoluntarySwitches) / sec,
		"loopWakeupsPerSec": loops,
		"heapInuseMB":       p1.HeapInuseMB, "goroutines": p1.Goroutines,
	}
	out, _ := json.MarshalIndent(res, "", "  ")
	t.Logf("idle connected cluster:\n%s", out)
	if f := os.Getenv("IDLE_OUT"); f != "" {
		_ = os.WriteFile(f, out, 0o644)
	}
}
