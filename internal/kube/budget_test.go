package kube

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// A server whose /block requests wait until released, counting how many wait at once.
type slowServer struct {
	*httptest.Server
	release chan struct{}
	now     atomic.Int32
	peak    atomic.Int32
	hits    atomic.Int32
}

func newSlowServer(t *testing.T) *slowServer {
	s := &slowServer{release: make(chan struct{})}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.hits.Add(1)
		if strings.HasPrefix(r.URL.Path, "/block") {
			n := s.now.Add(1)
			for {
				p := s.peak.Load()
				if n <= p || s.peak.CompareAndSwap(p, n) {
					break
				}
			}
			select {
			case <-s.release:
			case <-r.Context().Done():
			}
			s.now.Add(-1)
		}
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(func() {
		close(s.release)
		s.Close()
	})
	return s
}

func budgetClient(t *testing.T, url string) (*http.Client, *budget) {
	t.Helper()
	cfg := &rest.Config{Host: url}
	b := withBudget(cfg)
	rt, err := rest.TransportFor(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Transport: rt}, b
}

func get(ctx context.Context, c *http.Client, url string) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestBudgetLimitsRequestsInFlight(t *testing.T) {
	s := newSlowServer(t)
	c, b := budgetClient(t, s.URL)
	for range 3 * budgetInFlight {
		go func() { _ = get(context.Background(), c, s.URL+"/block") }()
	}
	waitUntil(t, "a full budget", func() bool { all, _ := b.inFlight(); return all == budgetInFlight })
	time.Sleep(50 * time.Millisecond)
	if p := s.peak.Load(); p != budgetInFlight {
		t.Fatalf("peak requests in flight = %d, want %d", p, budgetInFlight)
	}
}

func TestBudgetKeepsRoomForTheForeground(t *testing.T) {
	s := newSlowServer(t)
	c, b := budgetClient(t, s.URL)
	// Background work piles up far beyond its lane.
	for range 4 * budgetBackground {
		go func() { _ = get(background(context.Background()), c, s.URL+"/block") }()
	}
	waitUntil(t, "a full background lane", func() bool { _, bg := b.inFlight(); return bg == budgetBackground })
	time.Sleep(50 * time.Millisecond)
	if all, _ := b.inFlight(); all != budgetBackground {
		t.Fatalf("background holds %d slots, want only its lane of %d", all, budgetBackground)
	}
	// A click is answered at once.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := get(ctx, c, s.URL+"/now"); err != nil {
		t.Fatalf("a foreground request waited behind background work: %v", err)
	}
}

func TestBudgetLetsLongRunningRequestsThrough(t *testing.T) {
	s := newSlowServer(t)
	c, b := budgetClient(t, s.URL)
	for range budgetInFlight {
		go func() { _ = get(context.Background(), c, s.URL+"/block") }()
	}
	waitUntil(t, "a full budget", func() bool { all, _ := b.inFlight(); return all == budgetInFlight })
	for _, path := range []string{"/api/v1/pods?watch=true", "/api/v1/namespaces/a/pods/p/log?follow=true", "/api/v1/namespaces/a/pods/p/exec"} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		if err := get(ctx, c, s.URL+path); err != nil {
			t.Errorf("%s waited for a slot: %v", path, err)
		}
		cancel()
	}
}

func TestBudgetEndsRequestsThatHang(t *testing.T) {
	old := requestDeadline
	requestDeadline = 150 * time.Millisecond
	t.Cleanup(func() { requestDeadline = old })
	s := newSlowServer(t)
	c, b := budgetClient(t, s.URL)
	start := time.Now()
	if err := get(context.Background(), c, s.URL+"/block"); err == nil {
		t.Fatal("a hanging request must fail at its deadline")
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("took %v", d)
	}
	waitUntil(t, "the slot to be freed", func() bool { all, _ := b.inFlight(); return all == 0 })
}

// What one failing call costs, by the server's answer.
func TestFailuresMakeABoundedNumberOfRequests(t *testing.T) {
	cases := []struct {
		name   string
		status int
		header map[string]string
		max    int32
	}{
		{"429 with Retry-After", 429, map[string]string{"Retry-After": "0"}, 11},
		{"503 with Retry-After", 503, map[string]string{"Retry-After": "0"}, 11},
		{"500", 500, nil, 1},
		{"401", 401, nil, 1},
		{"403", 403, nil, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var hits atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				for k, v := range tc.header {
					w.Header().Set(k, v)
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_, _ = fmt.Fprintf(w, `{"kind":"Status","apiVersion":"v1","status":"Failure","code":%d}`, tc.status)
			}))
			defer srv.Close()
			cfg := &rest.Config{Host: srv.URL}
			withBudget(cfg)
			client := kubernetes.NewForConfigOrDie(cfg)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if _, err := client.CoreV1().Pods("a").List(ctx, metav1.ListOptions{}); err == nil {
				t.Fatal("want an error")
			}
			if n := hits.Load(); n < 1 || n > tc.max {
				t.Fatalf("requests = %d, want 1..%d", n, tc.max)
			}
		})
	}

	t.Run("network loss", func(t *testing.T) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		var accepted atomic.Int32
		go func() {
			for {
				conn, err := ln.Accept()
				if err != nil {
					return
				}
				accepted.Add(1)
				_ = conn.Close() // the connection drops before an answer
			}
		}()
		defer ln.Close()
		cfg := &rest.Config{Host: "http://" + ln.Addr().String()}
		withBudget(cfg)
		client := kubernetes.NewForConfigOrDie(cfg)
		// client-go retries a reset read about once a second, at most 10 times.
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if _, err := client.CoreV1().Pods("a").List(ctx, metav1.ListOptions{}); err == nil {
			t.Fatal("want an error")
		}
		if n := accepted.Load(); n > 11 {
			t.Fatalf("connections = %d, want at most 11", n)
		}
	})
}

// Twenty clusters behind one failing API server, all connecting at once:
// each attempt asks once and stops; nothing loops.
func TestTwentyClustersReconnectingMakeBoundedRequests(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	dir := t.TempDir()
	var b strings.Builder
	b.WriteString("apiVersion: v1\nkind: Config\nusers:\n- name: u\n  user: {token: t}\nclusters:\n")
	for i := range 20 {
		fmt.Fprintf(&b, "- name: c%d\n  cluster: {server: %q}\n", i, srv.URL)
	}
	b.WriteString("contexts:\n")
	for i := range 20 {
		fmt.Fprintf(&b, "- name: ctx-%d\n  context: {cluster: c%d, user: u}\n", i, i)
	}
	cfg := filepath.Join(dir, "config")
	if err := os.WriteFile(cfg, []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KUBECONFIG", cfg)
	store, err := OpenStore(filepath.Join(dir, "contexts.json"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := NewManager(ctx, store, &recorder{})
	defer m.Shutdown()
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m.Connect(fmt.Sprintf("ctx-%d", i))
		}()
	}
	wg.Wait()
	waitUntil(t, "every attempt to fail", func() bool {
		for i := range 20 {
			if st := stateOf(m, fmt.Sprintf("ctx-%d", i)); st.Connection == Connecting {
				return false
			}
		}
		return true
	})
	settled := hits.Load()
	time.Sleep(2 * time.Second)
	if n := hits.Load(); n != settled || n > 3*20 {
		t.Fatalf("requests = %d after the attempts and %d two seconds later; want at most 60 and no more after", settled, n)
	}
}

// A gzip bomb in a release Secret is refused instead of filling memory.
func TestDecodeReleaseRefusesAGzipBomb(t *testing.T) {
	var zbuf bytes.Buffer
	zw := gzip.NewWriter(&zbuf)
	zeros := make([]byte, 1<<20)
	for range (maxReleaseBytes >> 20) + 2 {
		_, _ = zw.Write(zeros)
	}
	_ = zw.Close()
	data := []byte(base64.StdEncoding.EncodeToString(zbuf.Bytes()))
	if zbuf.Len() > 1<<20 {
		t.Fatalf("the bomb is %d bytes compressed; it must fit a Secret", zbuf.Len())
	}
	if _, err := decodeRelease(data); err == nil || !strings.Contains(err.Error(), "larger than") {
		t.Fatalf("err = %v", err)
	}
}
