package app

import (
	"fmt"
	"io"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// The app writes its own log for support ("I can't connect"): connection
// changes, errors and every change it makes to a cluster. It never contains
// Secret values, YAML bodies, log lines or shell input.

const (
	logMaxBytes = 5 << 20 // rotate at 5 MB, keeping one older file
	logName     = "clustrail.log"
)

// LogDir is where clustrail.log lives: the user cache directory.
func LogDir() string {
	dir, err := os.UserCacheDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "clustrail")
	}
	return filepath.Join(dir, "clustrail")
}

// LogPath is the current log file.
func LogPath() string { return filepath.Join(LogDir(), logName) }

// SetupLogging sends slog and the standard logger to the log file (and to
// stderr when it is a terminal, for development). Errors leave logging on stderr.
func SetupLogging() {
	w, err := newRotatingFile(LogPath(), logMaxBytes)
	var out io.Writer = os.Stderr
	if err == nil {
		out = w
		if fi, e := os.Stderr.Stat(); e == nil && fi.Mode()&os.ModeCharDevice != 0 {
			out = io.MultiWriter(w, os.Stderr)
		}
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(out, &slog.HandlerOptions{Level: logLevel()})))
	log.SetOutput(out)
	slog.Info("clustrail starting", "version", Version, "os", runtime.GOOS, "arch", runtime.GOARCH, "go", runtime.Version())
	if err != nil {
		slog.Warn("log file unavailable", "error", err)
	}
}

type rotatingFile struct {
	mu   sync.Mutex
	path string
	max  int64
	f    *os.File
	size int64
}

func newRotatingFile(path string, max int64) (*rotatingFile, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	r := &rotatingFile{path: path, max: max}
	return r, r.open()
}

func (r *rotatingFile) open() error {
	f, err := os.OpenFile(r.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	r.f, r.size = f, st.Size()
	return nil
}

func (r *rotatingFile) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.size+int64(len(p)) > r.max {
		r.f.Close()
		_ = os.Rename(r.path, r.path+".1")
		if err := r.open(); err != nil {
			return 0, err
		}
	}
	n, err := r.f.Write(p)
	r.size += int64(n)
	return n, err
}

// audit records a change Clustrail made (or tried) and passes the error through.
func audit(action, cluster, target string, err error) error {
	if err != nil {
		slog.Warn("change failed", "action", action, "cluster", cluster, "target", target, "error", err)
	} else {
		slog.Info("change", "action", action, "cluster", cluster, "target", target)
	}
	return err
}

func target(parts ...string) string {
	var out []string
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, "/")
}

// LogInfo tells the UI where the log is.
type LogInfo struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

func (w *Workspace) LogFile() LogInfo {
	info := LogInfo{Path: LogPath()}
	if st, err := os.Stat(info.Path); err == nil {
		info.Size = st.Size()
	}
	return info
}

// LogClientError records an error from the interface (a view that crashed,
// an unhandled rejection) in the log. Nothing leaves the machine.
func (w *Workspace) LogClientError(message, detail string) {
	const max = 4000
	if len(detail) > max {
		detail = detail[:max] + "…"
	}
	slog.Error("interface error", "message", message, "detail", detail)
}

// RevealLog shows the log file in the system file manager.
func (w *Workspace) RevealLog() error {
	return revealInFileManager(LogPath())
}

func revealInFileManager(path string) error {
	var cmd []string
	switch runtime.GOOS {
	case "darwin":
		cmd = []string{"open", "-R", path}
	case "windows":
		cmd = []string{"explorer", "/select," + path}
	default:
		cmd = []string{"xdg-open", filepath.Dir(path)}
	}
	if err := startDetached(cmd[0], cmd[1:]...); err != nil {
		return fmt.Errorf("could not open the file manager: %w", err)
	}
	return nil
}

// logLevel is Info, or Debug with CLUSTRAIL_DEBUG=1.
func logLevel() slog.Level {
	if os.Getenv("CLUSTRAIL_DEBUG") == "1" {
		return slog.LevelDebug
	}
	return slog.LevelInfo
}
