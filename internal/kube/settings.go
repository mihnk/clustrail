package kube

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// ContextSettings is what Clustrail stores about a kubeconfig context. The
// kubeconfig file itself is never written.
type ContextSettings struct {
	Env       Environment `json:"env"`
	Protected bool        `json:"protected"`
	ReadOnly  bool        `json:"readOnly"`
	Hidden    bool        `json:"hidden,omitempty"`
}

type settingsFile struct {
	Contexts map[string]ContextSettings `json:"contexts"`
	// Contexts seen before. A context that is neither known nor stored shows as "New".
	Known []string `json:"known"`
	// Kubeconfig files added in Clustrail, in addition to KUBECONFIG / ~/.kube/config.
	ExtraKubeconfigs []string `json:"extraKubeconfigs,omitempty"`
	Selected         []string `json:"selected,omitempty"`
	FirstRunDone     bool     `json:"firstRunDone"`
	// SetupDone: first-run setup was finished or skipped. Missing in files
	// written before setup existed, whose users are past it.
	SetupDone *bool `json:"setupDone,omitempty"`
	// Servers is the API server each context was last confirmed to point at.
	// Environment and protection are stored by context name; when the name
	// starts pointing elsewhere they must be confirmed again.
	Servers map[string]string `json:"servers,omitempty"`
}

// Store persists context settings as JSON in the user config directory
// (~/.config/clustrail on Linux, ~/Library/Application Support/clustrail on macOS).
type Store struct {
	mu   sync.Mutex
	path string
	data settingsFile
}

func DefaultStorePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "clustrail", "contexts.json"), nil
}

func OpenStore(path string) (*Store, error) {
	s := &Store{path: path, data: settingsFile{Contexts: map[string]ContextSettings{}}}
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		s.data.SetupDone = new(bool) // a fresh install starts with setup
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &s.data); err != nil {
		return nil, err
	}
	if s.data.Contexts == nil {
		s.data.Contexts = map[string]ContextSettings{}
	}
	return s, nil
}

func (s *Store) save() error {
	if s.path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Settings returns the stored settings of a context, or a default derived
// from its name. ok is false when nothing is stored yet.
func (s *Store) Settings(context, displayName string) (cs ContextSettings, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cs, ok = s.data.Contexts[context]
	if !ok {
		env := GuessEnv(context + " " + displayName)
		cs = ContextSettings{Env: env, Protected: env == EnvProd}
	}
	return cs, ok
}

func (s *Store) SetSettings(context string, cs ContextSettings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Contexts[context] = cs
	s.markKnownLocked(context)
	return s.save()
}

func (s *Store) markKnownLocked(context string) {
	for _, k := range s.data.Known {
		if k == context {
			return
		}
	}
	s.data.Known = append(s.data.Known, context)
}

// IsNew reports whether a context appeared after the first run and was never added.
func (s *Store) IsNew(context string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.data.FirstRunDone {
		return false
	}
	for _, k := range s.data.Known {
		if k == context {
			return false
		}
	}
	return true
}

// MarkKnown records every context present at first start, so only later
// additions appear as "New".
func (s *Store) MarkKnown(contexts []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range contexts {
		s.markKnownLocked(c)
	}
	s.data.FirstRunDone = true
	return s.save()
}

func (s *Store) ExtraKubeconfigs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.data.ExtraKubeconfigs...)
}

func (s *Store) AddKubeconfig(path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.data.ExtraKubeconfigs {
		if p == path {
			return nil
		}
	}
	s.data.ExtraKubeconfigs = append(s.data.ExtraKubeconfigs, path)
	return s.save()
}

func (s *Store) Selected() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.data.Selected...) // [] rather than null in JSON
}

func (s *Store) SetSelected(ids []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Selected = append([]string(nil), ids...)
	return s.save()
}

func (s *Store) FirstRunDone() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.FirstRunDone
}

// SetupDone reports whether first-run setup was finished or skipped.
func (s *Store) SetupDone() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.SetupDone == nil || *s.data.SetupDone
}

func (s *Store) SetSetupDone(done bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.SetupDone = &done
	return s.save()
}

// SetKnown replaces the set of known contexts: the ones chosen in setup.
// Every other context shows as available ("New") in Connections.
func (s *Store) SetKnown(contexts []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Known = append([]string(nil), contexts...)
	s.data.FirstRunDone = true
	return s.save()
}

// ConfirmedServer is the server a context was last confirmed to point at ("" if never recorded).
func (s *Store) ConfirmedServer(context string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.Servers[context]
}

// RecordServers stores the server of contexts that have none recorded yet
// (first sight); it never overwrites a confirmed one.
func (s *Store) RecordServers(servers map[string]string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	for ctx, server := range servers {
		if server == "" {
			continue
		}
		if s.data.Servers == nil {
			s.data.Servers = map[string]string{}
		}
		if _, ok := s.data.Servers[ctx]; !ok {
			s.data.Servers[ctx] = server
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return s.save()
}

// ConfirmServer records that the user accepted the context's new server.
func (s *Store) ConfirmServer(context, server string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Servers == nil {
		s.data.Servers = map[string]string{}
	}
	s.data.Servers[context] = server
	return s.save()
}
