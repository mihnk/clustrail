package kube

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/aymanbagabas/go-pty"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
	"k8s.io/client-go/tools/remotecommand"
)

// A local terminal: the user's shell on this machine, with KUBECONFIG set to
// a temporary file that holds only one cluster's context. kubectl, helm and
// every other tool in it talk to that cluster; the user's own kubeconfig is
// not changed. The file is deleted when the session ends, and leftovers (a
// crash) at the next start.

type LocalShellRequest struct {
	Cluster string `json:"cluster"`
	Cols    uint16 `json:"cols"`
	Rows    uint16 `json:"rows"`
}

type LocalShellInfo struct {
	ID string `json:"id"`
	// Shell is the program started, e.g. "/bin/zsh" or "powershell.exe".
	Shell   string `json:"shell"`
	Context string `json:"context"`
}

// localShellDir holds the temporary kubeconfigs (0700).
func localShellDir() string {
	dir, err := os.UserCacheDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "clustrail", "shells")
}

// contextKubeconfig is the merged kubeconfig cut down to one context, made
// current. Paths in it were already made absolute when it was loaded.
func contextKubeconfig(merged *clientcmdapi.Config, context string) ([]byte, error) {
	if _, ok := merged.Contexts[context]; !ok {
		return nil, fmt.Errorf("context %q not found in kubeconfig", context)
	}
	cfg := merged.DeepCopy()
	cfg.CurrentContext = context
	if err := clientcmdapi.MinifyConfig(cfg); err != nil {
		return nil, err
	}
	cfg.Preferences = clientcmdapi.Preferences{}
	cfg.Extensions = nil
	return clientcmd.Write(*cfg)
}

// userShell is the login shell on Unix ($SHELL, else /bin/sh) and PowerShell
// on Windows (else %ComSpec%).
func userShell() (string, []string) {
	if runtime.GOOS == "windows" {
		if p, err := exec.LookPath("powershell.exe"); err == nil {
			return p, []string{"-NoLogo"}
		}
		if c := os.Getenv("ComSpec"); c != "" {
			return c, nil
		}
		return "cmd.exe", nil
	}
	if s := os.Getenv("SHELL"); s != "" {
		return s, []string{"-l"}
	}
	return "/bin/sh", []string{"-l"}
}

// shellEnv is the environment with KUBECONFIG replaced.
func shellEnv(kubeconfig string) []string {
	out := []string{}
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "KUBECONFIG=") {
			continue
		}
		out = append(out, kv)
	}
	return append(out, "KUBECONFIG="+kubeconfig, "TERM=xterm-256color")
}

// cleanLocalShells removes kubeconfigs no live session uses (a crash left them).
func (m *Manager) cleanLocalShells() {
	entries, err := os.ReadDir(localShellDir())
	if err != nil {
		return
	}
	m.streams.mu.Lock()
	live := map[string]bool{}
	for _, s := range m.streams.exec {
		if s.cleanup != "" {
			live[filepath.Base(s.cleanup)] = true
		}
	}
	m.streams.mu.Unlock()
	for _, e := range entries {
		if !live[e.Name()] {
			_ = os.Remove(filepath.Join(localShellDir(), e.Name()))
		}
	}
}

// StartLocalShell opens the user's shell with the cluster's context. kubectl
// in it can change the cluster, so read-only contexts refuse it, like a shell
// in a pod.
func (m *Manager) StartLocalShell(req LocalShellRequest) (LocalShellInfo, error) {
	if _, err := m.writable(req.Cluster); err != nil {
		return LocalShellInfo{}, err
	}
	m.mu.Lock()
	kc := m.kc
	name := ""
	if st := m.state[req.Cluster]; st != nil {
		name = st.Context
	}
	m.mu.Unlock()
	raw, err := contextKubeconfig(kc.Merged, name)
	if err != nil {
		return LocalShellInfo{}, err
	}
	m.cleanLocalShells()
	if err := os.MkdirAll(localShellDir(), 0o700); err != nil {
		return LocalShellInfo{}, err
	}
	f, err := os.CreateTemp(localShellDir(), "kubeconfig-*")
	if err != nil {
		return LocalShellInfo{}, err
	}
	path := f.Name()
	_, werr := f.Write(raw)
	cerr := f.Close()
	if err := errors.Join(werr, cerr, os.Chmod(path, 0o600)); err != nil {
		_ = os.Remove(path)
		return LocalShellInfo{}, err
	}

	p, err := pty.New()
	if err != nil {
		_ = os.Remove(path)
		return LocalShellInfo{}, fmt.Errorf("no terminal available: %w", err)
	}
	if req.Cols > 0 && req.Rows > 0 {
		_ = p.Resize(int(req.Cols), int(req.Rows))
	}
	shell, args := userShell()
	ctx, cancel := context.WithCancel(m.ctx)
	cmd := p.CommandContext(ctx, shell, args...)
	cmd.Env = shellEnv(path)
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	if err := cmd.Start(); err != nil {
		cancel()
		_ = p.Close()
		_ = os.Remove(path)
		return LocalShellInfo{}, fmt.Errorf("start %s: %w", shell, err)
	}

	id := m.streams.next("exec")
	pr, pw := io.Pipe()
	sess := &execSession{cluster: req.Cluster, stdin: pw, sizes: make(chan remotecommand.TerminalSize, 4), cancel: cancel, cleanup: path}
	m.streams.mu.Lock()
	m.streams.exec[id] = sess
	m.streams.mu.Unlock()

	// Input and resizes go to the terminal until the session closes.
	safeGo("local shell input", nil, func() { _, _ = io.Copy(p, pr) })
	safeGo("local shell resize", nil, func() {
		for {
			select {
			case <-ctx.Done():
				return
			case s := <-sess.sizes:
				_ = p.Resize(int(s.Width), int(s.Height))
			}
		}
	})
	safeGo("local shell", func(err error) {
		code := -1
		m.emit.Emit(EventExec, ExecOutput{ID: id, Exit: &code, Err: err.Error()})
		m.CloseExec(id)
	}, func() {
		out := emitWriter{id: id, emit: m.emit}
		done := make(chan struct{})
		// Ends with the terminal: Read fails once it is closed below.
		safeGo("local shell output", func(error) { close(done) }, func() {
			_, _ = io.Copy(out, p)
			close(done)
		})
		err := cmd.Wait()
		code := 0
		res := ExecOutput{ID: id}
		var exitErr *exec.ExitError
		switch {
		case err == nil:
		case errors.As(err, &exitErr):
			code = exitErr.ExitCode()
		case ctx.Err() != nil:
			code = 130
		default:
			code, res.Err = -1, err.Error()
		}
		_ = p.Close()
		<-done
		res.Exit = &code
		m.emit.Emit(EventExec, res)
		m.CloseExec(id)
	})
	return LocalShellInfo{ID: id, Shell: shell, Context: name}, nil
}
