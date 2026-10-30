package app

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMergePath(t *testing.T) {
	got := mergePath("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin", "/usr/local/bin::/bin")
	if want := "/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin"; got != want {
		t.Fatalf("mergePath = %q, want %q", got, want)
	}
}

func TestExtractMarked(t *testing.T) {
	out := "Welcome banner\n" + pathMarker + "/a:/b" + pathMarker + "\nbye"
	if got := extractMarked(out); got != "/a:/b" {
		t.Fatalf("extractMarked = %q", got)
	}
	if extractMarked("no markers") != "" {
		t.Fatal("missing markers must give empty")
	}
}

func TestLoginShellPath(t *testing.T) {
	// A fake shell standing in for the user's: its PATH must come back.
	dir := t.TempDir()
	shell := filepath.Join(dir, "fakesh")
	if err := os.WriteFile(shell, []byte("#!/bin/sh\necho banner\nPATH=/from/login/shell:/usr/bin\nexport PATH\nshift 3\nsh -c \"$1\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHELL", shell)
	if got := loginShellPath(3 * time.Second); got != "/from/login/shell:/usr/bin" {
		t.Fatalf("loginShellPath = %q", got)
	}
}
