package kube

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/util/flowcontrol"
)

// Request budgets per cluster (issue D5). Every client of one connection
// (typed, dynamic, metrics, discovery, Helm) shares:
//
//   - one token bucket (QPS and burst), instead of one per client;
//   - a limit on requests in flight, with a lane for background work (polls,
//     probes, metrics) that can take only part of it, so a click is never
//     queued behind a slow cluster's background lists;
//   - a deadline for every short request that came without one, so a
//     request that hangs ends and its slot is freed.
//
// Watches, followed logs and upgraded connections (exec, attach, port
// forwarding) last as long as the user keeps them and are not counted.
// Each connection has its own budget, so a slow cluster does not delay
// another. Retries stay with client-go: a 429 or 503 with Retry-After is
// retried as the server asks, at most 10 times; other errors are returned
// once. Nothing here retries a change.
const (
	budgetQPS        = 50
	budgetBurst      = 100
	budgetInFlight   = 16
	budgetBackground = 8
)

// requestDeadline is the default deadline of a short request (tests shorten it).
var requestDeadline = 60 * time.Second

type budgetKey struct{}

// background marks requests made under ctx as background work: they use
// the background lane and never take every slot.
func background(ctx context.Context) context.Context {
	return context.WithValue(ctx, budgetKey{}, true)
}

func isBackground(ctx context.Context) bool {
	b, _ := ctx.Value(budgetKey{}).(bool)
	return b
}

type budget struct {
	slots      chan struct{}
	background chan struct{}
}

func newBudget(inFlight, bg int) *budget {
	return &budget{slots: make(chan struct{}, inFlight), background: make(chan struct{}, bg)}
}

// withBudget gives every client made from cfg (and its copies) one shared budget.
func withBudget(cfg *rest.Config) *budget {
	b := newBudget(budgetInFlight, budgetBackground)
	cfg.QPS, cfg.Burst = budgetQPS, budgetBurst
	cfg.RateLimiter = flowcontrol.NewTokenBucketRateLimiter(budgetQPS, budgetBurst)
	cfg.Wrap(func(rt http.RoundTripper) http.RoundTripper { return &budgetTransport{next: rt, b: b} })
	return b
}

type budgetTransport struct {
	next http.RoundTripper
	b    *budget
}

// longRunning: watches, followed logs and upgraded connections.
func longRunning(req *http.Request) bool {
	q := req.URL.Query()
	if q.Get("watch") == "true" || q.Get("watch") == "1" || q.Get("follow") == "true" {
		return true
	}
	if strings.EqualFold(req.Header.Get("Connection"), "upgrade") || req.Header.Get("Upgrade") != "" {
		return true
	}
	p := req.URL.Path
	return strings.HasSuffix(p, "/exec") || strings.HasSuffix(p, "/attach") || strings.HasSuffix(p, "/portforward") || strings.HasSuffix(p, "/log")
}

func acquire(ctx context.Context, ch chan struct{}) error {
	select {
	case ch <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (t *budgetTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if longRunning(req) {
		return t.next.RoundTrip(req)
	}
	ctx := req.Context()
	cancel := context.CancelFunc(func() {})
	if _, ok := ctx.Deadline(); !ok {
		ctx, cancel = context.WithTimeout(ctx, requestDeadline)
		req = req.WithContext(ctx)
	}
	bg := isBackground(ctx)
	if bg {
		if err := acquire(ctx, t.b.background); err != nil {
			cancel()
			return nil, err
		}
	}
	if err := acquire(ctx, t.b.slots); err != nil {
		if bg {
			<-t.b.background
		}
		cancel()
		return nil, err
	}
	var once sync.Once
	release := func() {
		once.Do(func() {
			<-t.b.slots
			if bg {
				<-t.b.background
			}
			cancel()
		})
	}
	resp, err := t.next.RoundTrip(req)
	if err != nil {
		release()
		return nil, err
	}
	// The slot is held until the body is read and closed: that is when the request is done.
	resp.Body = &releasingBody{ReadCloser: resp.Body, release: release}
	return resp, nil
}

type releasingBody struct {
	io.ReadCloser
	release func()
}

func (b *releasingBody) Close() error {
	err := b.ReadCloser.Close()
	b.release()
	return err
}

// inFlight reports the requests holding a slot, for tests and diagnostics.
func (b *budget) inFlight() (all, bg int) { return len(b.slots), len(b.background) }
