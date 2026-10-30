package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRotatingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clustrail.log")
	w, err := newRotatingFile(path, 32)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{"first line 0123456789\n", "second line 0123456789\n"} {
		if _, err := w.Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	cur, _ := os.ReadFile(path)
	old, _ := os.ReadFile(path + ".1")
	if !strings.HasPrefix(string(cur), "second") || !strings.HasPrefix(string(old), "first") {
		t.Fatalf("current %q, rotated %q", cur, old)
	}
}

func TestYAMLTargetHasNoContent(t *testing.T) {
	got := yamlTarget("apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: payments\ndata:\n  password: c2VjcmV0\n")
	if got != "Secret/payments/db" {
		t.Fatalf("target = %q", got)
	}
}
