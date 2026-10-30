package kube

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"k8s.io/client-go/tools/clientcmd"
)

// First-run setup: find kubeconfig files, choose contexts, set environment and
// protection, test the connections. Nothing here writes a kubeconfig file;
// a pasted kubeconfig becomes a new file of its own.

// SetupLocation is one place Clustrail looked for a kubeconfig.
type SetupLocation struct {
	Path string `json:"path"`
	// Via: "default" (~/.kube/config), "env" ($KUBECONFIG) or "added" (in Clustrail).
	Via string `json:"via"`
	// State: found · missing · invalid · unset ($KUBECONFIG not set).
	State    string `json:"state"`
	Error    string `json:"error,omitempty"`
	Contexts int    `json:"contexts"`
}

// EnvHint says why an environment was suggested: Word appeared in Field
// (context · cluster · server). Empty when nothing suggested one.
type EnvHint struct {
	Word  string `json:"word"`
	Field string `json:"field"`
}

type SetupContext struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Cluster string `json:"cluster"`
	Server  string `json:"server"`
	Auth    string `json:"auth"`
	Source  string `json:"source"`
	Current bool   `json:"current"`
	// Env is stored (Stored) or suggested (Hint); "" when the user must choose.
	Env       Environment `json:"env"`
	Hint      *EnvHint    `json:"hint,omitempty"`
	Stored    bool        `json:"stored"`
	Protected bool        `json:"protected"`
	ReadOnly  bool        `json:"readOnly"`
	Known     bool        `json:"known"`
}

type SetupInfo struct {
	Needed    bool            `json:"needed"`
	Locations []SetupLocation `json:"locations"`
	Contexts  []SetupContext  `json:"contexts"`
}

// SuggestEnv looks for an environment word in the context name, then the
// cluster name, then the server address.
func SuggestEnv(context, cluster, server string) (Environment, *EnvHint) {
	words := []struct {
		env   Environment
		words []string
	}{
		// preprod before prod: it is a staging word containing "prod".
		{EnvStg, []string{"preprod", "staging", "stage", "stg", "uat", "qa"}},
		{EnvProd, []string{"production", "prod", "prd", "live"}},
		{EnvDev, []string{"development", "dev", "test", "sandbox", "local", "kind", "minikube", "k3d", "docker-desktop", "127.0.0.1", "localhost"}},
	}
	for _, f := range []struct{ name, value string }{{"context", context}, {"cluster", cluster}, {"server", server}} {
		v := strings.ToLower(f.value)
		for _, g := range words {
			for _, w := range g.words {
				if strings.Contains(v, w) {
					return g.env, &EnvHint{Word: w, Field: f.name}
				}
			}
		}
	}
	return "", nil
}

// Setup describes what first-run setup shows.
func (m *Manager) Setup() SetupInfo {
	m.mu.Lock()
	kc := m.kc
	ids := clusterIDs(kc.Contexts)
	synthetic := len(m.synthetic) > 0
	m.mu.Unlock()
	// Benchmarks (synthetic clusters) go straight to the workspace.
	info := SetupInfo{Needed: !m.store.SetupDone() && !synthetic, Locations: setupLocations(m.store.ExtraKubeconfigs(), kc), Contexts: []SetupContext{}}
	for _, c := range kc.Contexts {
		sc := SetupContext{ID: ids[c.Name], Name: c.Name, Server: c.Server, Auth: c.Auth, Source: c.Source, Current: c.Name == kc.Merged.CurrentContext, Known: !m.store.IsNew(c.Name)}
		if ctx := kc.Merged.Contexts[c.Name]; ctx != nil {
			sc.Cluster = ctx.Cluster
		}
		if cs, ok := m.store.Settings(c.Name, c.DisplayName); ok {
			sc.Env, sc.Protected, sc.ReadOnly, sc.Stored = cs.Env, cs.Protected, cs.ReadOnly, true
		} else {
			sc.Env, sc.Hint = SuggestEnv(c.Name, sc.Cluster, c.Server)
			sc.Protected = sc.Env == EnvProd
		}
		info.Contexts = append(info.Contexts, sc)
	}
	return info
}

func setupLocations(extra []string, kc *Kubeconfig) []SetupLocation {
	paths, _ := KubeconfigPaths(extra)
	env := os.Getenv(clientcmd.RecommendedConfigPathEnvVar) != ""
	var out []SetupLocation
	if !env {
		out = append(out, SetupLocation{Path: "$KUBECONFIG", Via: "env", State: "unset"})
	}
	for i, p := range paths {
		loc := SetupLocation{Path: homeShort(p), Via: "default", State: "found"}
		switch {
		case i >= len(paths)-len(extra):
			loc.Via = "added"
		case env:
			loc.Via = "env"
		}
		if _, err := os.Stat(p); err != nil {
			loc.State = "missing"
			if !os.IsNotExist(err) {
				loc.State, loc.Error = "invalid", err.Error()
			}
			out = append(out, loc)
			continue
		}
		for _, s := range kc.Sources {
			if s.Path == loc.Path || s.Resolved == loc.Path {
				loc.Contexts = s.Contexts
				if s.Error != "" {
					loc.State, loc.Error = "invalid", s.Error
				}
			}
		}
		out = append(out, loc)
	}
	return out
}

// SetupChoice is one context the user kept in setup.
type SetupChoice struct {
	ID        string      `json:"id"`
	Env       Environment `json:"env"`
	Protected bool        `json:"protected"`
	ReadOnly  bool        `json:"readOnly"`
}

// CompleteSetup stores the chosen contexts' settings and selects the given
// clusters. Contexts left out stay in the kubeconfig and show as available
// in Connections.
func (m *Manager) CompleteSetup(choices []SetupChoice, selected []string) error {
	m.mu.Lock()
	byID := map[string]string{}
	for id, st := range m.state {
		byID[id] = st.Context
	}
	m.mu.Unlock()
	known := make([]string, 0, len(choices))
	for _, c := range choices {
		name, ok := byID[c.ID]
		if !ok {
			return fmt.Errorf("unknown context %q", c.ID)
		}
		if c.Env != EnvProd && c.Env != EnvStg && c.Env != EnvDev {
			return fmt.Errorf("%s: choose an environment", name)
		}
		if err := m.store.SetSettings(name, ContextSettings{Env: c.Env, Protected: c.Protected || c.ReadOnly, ReadOnly: c.ReadOnly}); err != nil {
			return err
		}
		known = append(known, name)
	}
	if err := m.store.SetKnown(known); err != nil {
		return err
	}
	if err := m.store.SetSelected(selected); err != nil {
		return err
	}
	if err := m.store.SetSetupDone(true); err != nil {
		return err
	}
	slog.Info("setup complete", "contexts", len(known), "selected", len(selected))
	m.reload()
	return nil
}

// SkipSetup leaves every context as it is (all available, nothing selected).
func (m *Manager) SkipSetup() error {
	slog.Info("setup skipped")
	return m.store.SetSetupDone(true)
}

// RestartSetup shows setup again on the next look (Settings › Run setup again).
func (m *Manager) RestartSetup() error {
	return m.store.SetSetupDone(false)
}

// PasteKubeconfig saves pasted kubeconfig text as a new file in ~/.kube
// (owner-only, never over an existing file) and adds it to the loading chain.
func (m *Manager) PasteKubeconfig(text string) (string, error) {
	cfg, err := clientcmd.Load([]byte(text))
	if err != nil {
		return "", fmt.Errorf("not a kubeconfig: %w", err)
	}
	if len(cfg.Contexts) == 0 {
		return "", errors.New("the kubeconfig defines no contexts")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".kube")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	for i := 1; i < 100; i++ {
		name := "clustrail-pasted.yaml"
		if i > 1 {
			name = fmt.Sprintf("clustrail-pasted-%d.yaml", i)
		}
		path := filepath.Join(dir, name)
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		_, werr := f.WriteString(text)
		if cerr := f.Close(); werr == nil {
			werr = cerr
		}
		if werr != nil {
			_ = os.Remove(path)
			return "", werr
		}
		// The path only: the text holds credentials.
		slog.Info("kubeconfig pasted", "path", homeShort(path), "contexts", len(cfg.Contexts))
		return homeShort(path), m.AddKubeconfig(path)
	}
	return "", errors.New("too many pasted kubeconfig files in ~/.kube")
}

// SetupTestResult is the connection test of one context, summarized for setup.
type SetupTestResult struct {
	Steps []TestStep `json:"steps"`
	// State: connected · auth · unreachable · failed.
	State string `json:"state"`
	// Hint: the command that refreshes expired credentials, when there is one.
	Hint string `json:"hint,omitempty"`
}

// SetupTest runs the step-by-step connection test without connecting.
func (m *Manager) SetupTest(id string) (SetupTestResult, error) {
	steps, err := m.TestConnection(id)
	if err != nil {
		return SetupTestResult{}, err
	}
	res := SetupTestResult{Steps: steps, State: "connected"}
	for i, s := range steps {
		if s.Result != "failed" {
			continue
		}
		// Steps: DNS, TCP, TLS, authentication, API discovery, permissions.
		switch i {
		case 0, 1:
			res.State = "unreachable"
		case 3:
			res.State = "auth"
		default:
			res.State = "failed"
		}
		if i == 3 {
			m.mu.Lock()
			var plugin string
			if st := m.state[id]; st != nil {
				for _, c := range m.kc.Contexts {
					if c.Name == st.Context {
						plugin = c.AuthPlugin
					}
				}
				if ctx := m.kc.Merged.Contexts[st.Context]; ctx != nil {
					res.Hint = ReauthCommand(plugin, m.kc.Merged.AuthInfos[ctx.AuthInfo])
				}
			}
			m.mu.Unlock()
		}
		break
	}
	return res, nil
}
