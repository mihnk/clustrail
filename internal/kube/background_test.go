package kube

import (
	"context"
	"path/filepath"
	"testing"
)

func TestPauseWatchesKeepsBusyClusters(t *testing.T) {
	idle, _, _ := newFakeConn(t)
	busy, _, _ := newFakeConn(t)
	busy.id = "busy"
	for _, c := range []*clusterConn{idle, busy} {
		c.ctx, c.cancel = context.WithCancel(context.Background())
	}
	store, err := OpenStore(filepath.Join(t.TempDir(), "contexts.json"))
	if err != nil {
		t.Fatal(err)
	}
	m := &Manager{
		store:   store,
		kc:      &Kubeconfig{},
		state:   map[string]*Cluster{"test": {ID: "test", Connection: Connected}, "busy": {ID: "busy", Connection: Connected}},
		conns:   map[string]*clusterConn{"test": idle, "busy": busy},
		emit:    &recorder{},
		ctx:     context.Background(),
		streams: streams{logs: map[string]*logStream{}, exec: map[string]*execSession{"exec-1": {cluster: "busy"}}},
	}
	paused := m.PauseWatches()
	if len(paused) != 1 || paused[0] != "test" {
		t.Fatalf("paused = %v", paused)
	}
	if st := m.state["test"]; !st.Paused || st.Connection != Disconnected {
		t.Fatalf("test state = %+v", st)
	}
	if st := m.state["busy"]; st.Paused || m.conns["busy"] == nil {
		t.Fatal("a cluster with an open shell must stay connected")
	}
	if idle.ctx.Err() == nil {
		t.Fatal("the paused cluster's watches must stop")
	}
}
