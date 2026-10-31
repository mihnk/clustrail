package kube

import (
	"strings"
	"testing"
)

// A line over the limit is cut with a note and the lines after it still
// arrive; a scanner stopped at such a line, and the stream, reconnecting
// from the same timestamp, never got past it.
func TestReadLogLinesCutsLongLines(t *testing.T) {
	huge := strings.Repeat("x", 3<<20)
	in := "first\r\n" + huge + "\nafter the long line\n" + strings.Repeat("y", 64<<10) + "\nno newline at the end"
	var got []string
	if err := readLogLines(strings.NewReader(in), 1000, func(l string) { got = append(got, l) }); err != nil {
		t.Fatal(err)
	}
	if len(got) != 5 {
		t.Fatalf("%d lines", len(got))
	}
	if got[0] != "first" || got[2] != "after the long line" || got[4] != "no newline at the end" {
		t.Fatalf("lines = %q / %q / %q", got[0], got[2], got[4])
	}
	if !strings.HasPrefix(got[1], strings.Repeat("x", 1000)+" … [line cut: ") || !strings.Contains(got[1], "3144728 more bytes]") {
		t.Fatalf("long line = %q…", got[1][:1100])
	}
	if !strings.Contains(got[3], "64536 more bytes") {
		t.Fatalf("buffer-sized line = %q…", got[3][len(got[3])-40:])
	}
	// Empty lines are lines.
	got = nil
	_ = readLogLines(strings.NewReader("a\n\nb\n"), 10, func(l string) { got = append(got, l) })
	if strings.Join(got, "|") != "a||b" {
		t.Fatalf("lines = %q", got)
	}
}
