package kube

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestPortForwardProfilesAreSavedAndValidated(t *testing.T) {
	c, _, _ := newFakeConn(t)
	m := managerWith(c, false)
	path := filepath.Join(t.TempDir(), "contexts.json")
	s, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	m.store = s

	for _, bad := range []PortForwardProfile{
		{Cluster: "test", Kind: "Service", Namespace: "payments", Target: "ledger-db", Port: 5432},                 // no name
		{Name: "x", Cluster: "test", Kind: "Ingress", Namespace: "payments", Target: "web", Port: 80},              // not forwardable
		{Name: "x", Cluster: "test", Kind: "Service", Namespace: "payments", Target: "ledger-db", Port: 70000},     // port
		{Name: "x", Cluster: "test", Kind: "Service", Namespace: "", Target: "ledger-db", Port: 5432},              // namespace
		{Name: "x", Cluster: "test", Kind: "Service", Namespace: "payments", Target: "db", Port: 1, LocalPort: -1}, // local port
	} {
		if _, err := m.SavePortForwardProfile(bad); err == nil {
			t.Fatalf("accepted %+v", bad)
		}
	}
	p, err := m.SavePortForwardProfile(PortForwardProfile{Name: " ledger DB ", Group: "payments dev", Cluster: "test", Kind: "Service", Namespace: "payments", Target: "ledger-db", Port: 5432, LocalPort: 15432, Reconnect: true})
	if err != nil || p.ID == "" || p.Name != "ledger DB" {
		t.Fatalf("saved %+v, %v", p, err)
	}
	p.LocalPort = 25432
	if _, err := m.SavePortForwardProfile(p); err != nil {
		t.Fatal(err)
	}
	// The settings file keeps them across a restart.
	again, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := again.PortForwardProfiles(); len(got) != 1 || got[0].LocalPort != 25432 || !got[0].Reconnect {
		t.Fatalf("reopened: %+v", got)
	}
	if err := m.DeletePortForwardProfile(p.ID); err != nil || len(m.PortForwardProfiles()) != 0 {
		t.Fatalf("delete: %v, %+v", err, m.PortForwardProfiles())
	}
}

// Starting a profile goes through StartPortForward, so a read-only context
// refuses it, and the profile shows why until the next start.
func TestPortForwardProfileStartKeepsTheReadOnlyRule(t *testing.T) {
	c, _, _ := newFakeConn(t)
	m := managerWith(c, true)
	s, _ := OpenStore(filepath.Join(t.TempDir(), "contexts.json"))
	m.store = s
	p, err := m.SavePortForwardProfile(PortForwardProfile{Name: "db", Cluster: "test", Kind: "Service", Namespace: "payments", Target: "ledger-db", Port: 5432, AutoStart: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.StartPortForwardProfile(p.ID); err != ErrReadOnly {
		t.Fatalf("err = %v", err)
	}
	st := m.PortForwardProfiles()
	if len(st) != 1 || st[0].Forward != nil || !strings.Contains(st[0].LastError, "read-only") {
		t.Fatalf("state = %+v", st)
	}
	m.startProfilesOf("test") // auto-start on connect takes the same path
	if _, err := m.StartPortForwardProfile("nope"); err == nil {
		t.Fatal("an unknown profile must be refused")
	}
}

// A profile's request carries reconnect and its id onto the forward.
func TestPortForwardProfileRequest(t *testing.T) {
	r := PortForwardProfile{ID: "pfp-1", Cluster: "c", Namespace: "n", Kind: "Deployment", Target: "api", Port: 8080, LocalPort: 8080}.request()
	if !r.NoReconnect || r.ProfileID != "pfp-1" || r.Name != "api" {
		t.Fatalf("request = %+v", r)
	}
}
