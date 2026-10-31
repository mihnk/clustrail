package kube

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// A watch error or probe from a connection that was closed or replaced does
// not change the state of the connection that took its place.
func TestCallbacksOfAReplacedConnectionAreDropped(t *testing.T) {
	cur, _, _ := newFakeConn(t)
	old, _, _ := newFakeConn(t)
	m := managerWith(cur, false)
	m.state["test"].Connection = Connected
	m.kc, m.hidden = &Kubeconfig{}, map[string]bool{}
	m.store = &Store{data: settingsFile{Contexts: map[string]ContextSettings{}}}
	m.connStateFrom("test", old, Reconnecting, errors.New("watch closed: context canceled"))
	m.probeFrom("test", old, 0, errors.New("Unauthorized"))
	if s := stateOf(m, "test"); s.Connection != Connected || s.Error != "" {
		t.Fatalf("an old connection changed the state: %+v", s)
	}
	m.connStateFrom("test", cur, Reconnecting, errors.New("watch closed"))
	if s := stateOf(m, "test"); s.Connection != Reconnecting {
		t.Fatalf("the current connection's error is applied: %+v", s)
	}
}

// Unreadable settings are kept aside, setup runs again, and the interface is
// told once.
func TestUnreadableSettingsAreKeptAside(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "contexts.json")
	if err := os.WriteFile(path, []byte(`{"contexts": {"prod": {"env": "prod", "readOnly": tr`), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	aside := s.Recovered()
	if !strings.HasPrefix(aside, path+".corrupt-") || s.SetupDone() {
		t.Fatalf("recovered = %q, setup done = %v", aside, s.SetupDone())
	}
	if raw, _ := os.ReadFile(aside); !strings.Contains(string(raw), `"readOnly": tr`) {
		t.Fatal("the unreadable file is kept as it was")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("nothing is written over the settings path until something is saved")
	}
	rec := &recorder{}
	m := &Manager{store: s, emit: rec, state: map[string]*Cluster{}}
	m.AutoConnect()
	m.AutoConnect()
	if n := rec.notices(); len(n) != 1 || n[0].Title != "Settings file unreadable" || !strings.Contains(n[0].Detail, aside) {
		t.Fatalf("notices = %+v", n)
	}
}

// Concurrent writers of one file leave a whole file and no temporary files.
func TestWriteFileAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "samples.json")
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			body, _ := json.Marshal(map[string]any{"writer": i, "pad": strings.Repeat("x", 64<<10)})
			if err := writeFileAtomic(path, body); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("the file is not whole: %v", err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("left behind: %v", names)
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", fi.Mode().Perm())
	}
}
