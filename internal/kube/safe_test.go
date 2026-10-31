package kube

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func TestSafeGoRecoversAndReports(t *testing.T) {
	var noticed atomic.Value
	hook := func(component string) { noticed.Store(component) }
	panicNotice.Store(&hook)
	defer panicNotice.Store(nil)
	done := make(chan error, 1)
	safeGo("test component", func(err error) { done <- err }, func() { panic("boom") })
	select {
	case err := <-done:
		if !strings.Contains(err.Error(), "internal error in test component: boom") {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("onPanic was not called")
	}
	if noticed.Load() != "test component" {
		t.Fatalf("notice = %v", noticed.Load())
	}
}

func TestSafeLoopRestartsThenGivesUp(t *testing.T) {
	defer func(n int, d time.Duration) { loopRestarts, loopRestartDelay = n, d }(loopRestarts, loopRestartDelay)
	loopRestarts, loopRestartDelay = 2, time.Millisecond
	var runs atomic.Int32
	gaveUp := make(chan error, 1)
	safeLoop(context.Background(), "flaky loop", func(err error) { gaveUp <- err }, func() {
		runs.Add(1)
		panic("again")
	})
	select {
	case err := <-gaveUp:
		if runs.Load() != 3 || !strings.Contains(err.Error(), "flaky loop: again") {
			t.Fatalf("runs = %d, err = %v", runs.Load(), err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the loop did not give up")
	}

	// A loop that returns normally is not restarted.
	var once atomic.Int32
	safeLoop(context.Background(), "done loop", func(error) { t.Error("must not give up") }, func() { once.Add(1) })
	time.Sleep(50 * time.Millisecond)
	if once.Load() != 1 {
		t.Fatalf("runs = %d", once.Load())
	}
}

// A drain whose goroutine panics ends its job with the error; the test
// process (the app) keeps running.
func TestDrainPanicFailsTheJob(t *testing.T) {
	m, rec, _, _ := drainFixture(t)
	c, _ := m.conn("test")
	c.client.(*fake.Clientset).PrependReactor("create", "pods", func(a k8stesting.Action) (bool, runtime.Object, error) {
		if a.GetSubresource() == "eviction" {
			panic("unexpected nil in eviction response")
		}
		return false, nil, nil
	})
	if _, err := m.DrainNode("test", "node-1", DrainOptions{}, "jane"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "drain done", func() bool { return lastJob(rec).Done })
	if j := lastJob(rec); !strings.Contains(j.Error, "internal error in drain") {
		t.Fatalf("job = %+v", j)
	}
}

// Every goroutine in the package starts through safeGo or safeLoop.
func TestNoBareGoroutines(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") || name == "safe.go" {
			continue
		}
		f, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			if g, ok := n.(*ast.GoStmt); ok {
				t.Errorf("%s: bare go statement; start it with safeGo or safeLoop", fset.Position(g.Pos()))
			}
			return true
		})
	}
}
