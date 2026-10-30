package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const pathMarker = "__CLUSTRAIL_PATH__"

// FixPath makes kubeconfig exec plugins (aws, gke-gcloud-auth-plugin,
// kubelogin, …) findable when the app is started from Finder or a desktop
// launcher. Those start with a minimal PATH, not the one your terminal has, so
// the login shell is asked for its PATH once at startup.
func FixPath() {
	if runtime.GOOS == "windows" {
		return
	}
	shellPath := loginShellPath(3 * time.Second)
	home, _ := os.UserHomeDir()
	var extra []string
	for _, dir := range []string{"/opt/homebrew/bin", "/usr/local/bin", filepath.Join(home, ".local/bin"), filepath.Join(home, "google-cloud-sdk/bin"), filepath.Join(home, "bin")} {
		if st, err := os.Stat(dir); err == nil && st.IsDir() {
			extra = append(extra, dir)
		}
	}
	os.Setenv("PATH", mergePath(os.Getenv("PATH"), shellPath, strings.Join(extra, string(os.PathListSeparator))))
}

// loginShellPath runs the user's shell as an interactive login shell and reads
// its PATH. Markers skip anything the shell's startup files print.
func loginShellPath(timeout time.Duration) string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
		if runtime.GOOS == "linux" {
			shell = "/bin/bash"
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, shell, "-l", "-i", "-c", `printf '%s%s%s' "`+pathMarker+`" "$PATH" "`+pathMarker+`"`)
	cmd.Stdin = nil
	out, err := cmd.Output()
	if err != nil && len(out) == 0 {
		return ""
	}
	return extractMarked(string(out))
}

func extractMarked(out string) string {
	start := strings.Index(out, pathMarker)
	if start < 0 {
		return ""
	}
	rest := out[start+len(pathMarker):]
	end := strings.Index(rest, pathMarker)
	if end < 0 {
		return ""
	}
	return rest[:end]
}

// mergePath keeps the order: the shell's PATH first, then entries only the
// process had, then the well-known extras; duplicates and empties are dropped.
func mergePath(current, shell, extra string) string {
	seen := map[string]bool{}
	var out []string
	for _, list := range []string{shell, current, extra} {
		for _, dir := range filepath.SplitList(list) {
			if dir != "" && !seen[dir] {
				seen[dir] = true
				out = append(out, dir)
			}
		}
	}
	return strings.Join(out, string(os.PathListSeparator))
}
