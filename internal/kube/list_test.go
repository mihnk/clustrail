package kube

import (
	"testing"
	"time"
)

// Listing clusters while a known context is connected returned nothing and
// held the manager's lock forever: List called the GitOps watcher, which
// asked the manager for the environment and took the same lock again. Every
// call into the backend then hung.
func TestListWithAConnectedContextReturns(t *testing.T) {
	c, _, _ := newFakeConn(t)
	m := managerWith(c, false)
	m.kc, m.hidden = &Kubeconfig{}, map[string]bool{}
	m.store = &Store{data: settingsFile{Contexts: map[string]ContextSettings{"test": {Env: EnvProd}}, Known: []string{"test"}}}
	m.state["test"].Context, m.state["test"].Env = "test", EnvProd
	c.env = func() Environment { return m.envOf("test") }
	c.gitops = newGitOpsWatcher(c)
	done := make(chan ClusterList, 1)
	go func() { done <- m.List() }()
	select {
	case l := <-done:
		if len(l.Clusters) != 1 || len(l.Controllers) != 1 || l.Controllers[0].Env != EnvProd {
			t.Fatalf("list = %+v", l)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("List deadlocked")
	}
}
