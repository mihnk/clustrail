package kube

import (
	"strings"
	"testing"
	"time"
)

type logRecorder struct{ batches []LogBatch }

func (r *logRecorder) Emit(_ string, data any) {
	if b, ok := data.(LogBatch); ok {
		r.batches = append(r.batches, b)
	}
}

// A burst faster than the window takes: the waiting lines stay bounded, the
// newest are kept, and the next batch says how many were dropped and when.
func TestALogBurstStaysBoundedAndSaysWhatItDropped(t *testing.T) {
	oldLines := maxPendingLines
	maxPendingLines = 1000
	defer func() { maxPendingLines = oldLines }()
	ls := &logStream{id: "l", states: map[string]LogSourceState{}, pods: map[string]*followedPod{}, kicks: newKicker()}
	start := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	for i := range 5000 {
		ls.add(LogLine{Pod: "p", Container: "c", TS: start.Add(time.Duration(i) * time.Millisecond).Format(time.RFC3339Nano), Msg: "line"})
		if len(ls.lines) > maxPendingLines {
			t.Fatalf("waiting lines = %d", len(ls.lines))
		}
	}
	rec := &logRecorder{}
	for ls.flush(rec) {
	}
	var got []LogLine
	for _, b := range rec.batches {
		got = append(got, b.Lines...)
	}
	if got[0].Event != "dropped" || !strings.HasPrefix(got[0].Msg, "4000 lines dropped") {
		t.Fatalf("first line = %+v", got[0])
	}
	if n := len(got) - 1; n != 1000 {
		t.Fatalf("kept %d lines, want the newest 1000", n)
	}
	if last := got[len(got)-1]; last.TS != start.Add(4999*time.Millisecond).Format(time.RFC3339Nano) {
		t.Fatalf("the newest line must be kept, got %s", last.TS)
	}
	if ls.bytes != 0 {
		t.Fatalf("byte count after draining = %d", ls.bytes)
	}
}

func TestLongLinesAreBoundedByBytes(t *testing.T) {
	oldBytes := maxPendingBytes
	maxPendingBytes = 64 << 10
	defer func() { maxPendingBytes = oldBytes }()
	ls := &logStream{id: "l", states: map[string]LogSourceState{}, pods: map[string]*followedPod{}, kicks: newKicker()}
	big := strings.Repeat("x", 4096)
	for range 100 {
		ls.add(LogLine{Pod: "p", Msg: big})
	}
	if ls.bytes > maxPendingBytes || ls.dropped == 0 {
		t.Fatalf("bytes %d (limit %d), dropped %d", ls.bytes, maxPendingBytes, ls.dropped)
	}
}
