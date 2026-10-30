package kube

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSamplesSurviveRestart(t *testing.T) {
	dir := t.TempDir()
	old := metricsCacheDir
	metricsCacheDir = func() string { return dir }
	t.Cleanup(func() { metricsCacheDir = old })

	now := time.Now()
	s := newSampleStore(4)
	s.add("payments/api-1/api", now.Add(-3*time.Hour), 100) // too old to come back
	s.add("payments/api-1/api", now.Add(-time.Minute), 200)
	s.add("payments/api-1/api", now, 210)
	path := samplesPath("prod/eu")
	if filepath.Dir(path) != dir || filepath.Base(path) != "prod_eu.json" {
		t.Fatalf("path = %s", path)
	}
	if err := s.save(path); err != nil {
		t.Fatal(err)
	}

	// The next connect loads before it collects, so the series stays in time order.
	next := newSampleStore(4)
	next.load(path, now, sampleMaxAge)
	next.add("payments/api-1/api", now.Add(15*time.Second), 220)
	ts, vals := next.series("payments/api-1/api")
	if len(vals) != 3 || vals[0] != 200 || vals[1] != 210 || vals[2] != 220 || ts[0] >= ts[2] {
		t.Fatalf("ts=%v vals=%v", ts, vals)
	}

	if err := newSampleStore(4).save(path); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("an empty store removes the file")
	}
}
