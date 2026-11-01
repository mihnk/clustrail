package kube

import (
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"
)

// Port-forward profiles: forwards used often, saved with Clustrail's settings
// on this machine. One click starts a profile; a profile can start by itself
// once its cluster is connected. Starting goes through StartPortForward, so
// the read-only rule holds.

// EventPortForwardProfiles carries the profiles with their state whenever a forward or profile changes.
const EventPortForwardProfiles = "clustrail:pfprofiles"

// PortForwardProfile is a saved forward.
type PortForwardProfile struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Group     string `json:"group,omitempty"`
	Cluster   string `json:"cluster"`
	Namespace string `json:"namespace"`
	Kind      string `json:"kind"` // Pod, Service or Deployment
	Target    string `json:"target"`
	Port      int    `json:"port"`
	LocalPort int    `json:"localPort"`
	// Reconnect: when the pod goes away, reach another ready pod (or wait for
	// this one) with backoff. Off: the forward stops and says why.
	Reconnect bool `json:"reconnect"`
	// AutoStart: start once the cluster is connected.
	AutoStart bool `json:"autoStart,omitempty"`
}

// PortForwardProfileState is a profile with what it is doing now.
type PortForwardProfileState struct {
	PortForwardProfile
	// Forward is the running forward started from it, if any.
	Forward *PortForward `json:"forward,omitempty"`
	// LastError is why the last start failed, until the next start.
	LastError string `json:"lastError,omitempty"`
}

func (p *PortForwardProfile) validate() error {
	p.Name, p.Group = strings.TrimSpace(p.Name), strings.TrimSpace(p.Group)
	p.Namespace, p.Target = strings.TrimSpace(p.Namespace), strings.TrimSpace(p.Target)
	switch {
	case p.Name == "":
		return errors.New("a profile needs a name")
	case p.Cluster == "":
		return errors.New("a profile needs a cluster")
	case !slices.Contains([]string{"Pod", "Service", "Deployment"}, p.Kind):
		return fmt.Errorf("a profile forwards to a Pod, Service or Deployment, not %q", p.Kind)
	case p.Namespace == "" || p.Target == "":
		return errors.New("a profile needs the target's namespace and name")
	case p.Port <= 0 || p.Port > 65535:
		return errors.New("the target port must be 1–65535")
	case p.LocalPort < 0 || p.LocalPort > 65535:
		return errors.New("the local port must be 0 (any free port) to 65535")
	}
	return nil
}

func (p PortForwardProfile) request() PortForwardRequest {
	return PortForwardRequest{Cluster: p.Cluster, Namespace: p.Namespace, Kind: p.Kind, Name: p.Target, Port: p.Port, LocalPort: p.LocalPort, NoReconnect: !p.Reconnect, ProfileID: p.ID}
}

// Profiles in the settings file.

func (s *Store) PortForwardProfiles() []PortForwardProfile {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]PortForwardProfile{}, s.data.PortForwardProfiles...)
}

func (s *Store) savePortForwardProfile(p PortForwardProfile) (PortForwardProfile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.ID == "" {
		p.ID = fmt.Sprintf("pfp-%d", time.Now().UnixNano())
		s.data.PortForwardProfiles = append(s.data.PortForwardProfiles, p)
	} else {
		i := slices.IndexFunc(s.data.PortForwardProfiles, func(x PortForwardProfile) bool { return x.ID == p.ID })
		if i < 0 {
			return p, fmt.Errorf("no profile %s", p.ID)
		}
		s.data.PortForwardProfiles[i] = p
	}
	return p, s.save()
}

func (s *Store) deletePortForwardProfile(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.PortForwardProfiles = slices.DeleteFunc(s.data.PortForwardProfiles, func(x PortForwardProfile) bool { return x.ID == id })
	return s.save()
}

// profileErrors keeps why a profile's last start failed (memory only).
type profileErrors struct {
	mu sync.Mutex
	m  map[string]string
}

func (e *profileErrors) set(id, msg string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.m == nil {
		e.m = map[string]string{}
	}
	if msg == "" {
		delete(e.m, id)
	} else {
		e.m[id] = msg
	}
}

func (e *profileErrors) get(id string) string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.m[id]
}

// PortForwardProfiles lists the saved profiles with their running forward and last error.
func (m *Manager) PortForwardProfiles() []PortForwardProfileState {
	running := map[string]PortForward{}
	for _, f := range m.PortForwards() {
		if f.ProfileID != "" {
			running[f.ProfileID] = f
		}
	}
	out := []PortForwardProfileState{}
	if m.store == nil {
		return out
	}
	for _, p := range m.store.PortForwardProfiles() {
		st := PortForwardProfileState{PortForwardProfile: p, LastError: m.pfErrors.get(p.ID)}
		if f, ok := running[p.ID]; ok {
			st.Forward = &f
		}
		out = append(out, st)
	}
	return out
}

// SavePortForwardProfile adds a profile (no id) or replaces one.
func (m *Manager) SavePortForwardProfile(p PortForwardProfile) (PortForwardProfile, error) {
	if err := p.validate(); err != nil {
		return p, err
	}
	saved, err := m.store.savePortForwardProfile(p)
	if err == nil {
		m.emitForwards()
	}
	return saved, err
}

// DeletePortForwardProfile removes a profile; a forward it started keeps running.
func (m *Manager) DeletePortForwardProfile(id string) error {
	err := m.store.deletePortForwardProfile(id)
	m.pfErrors.set(id, "")
	m.emitForwards()
	return err
}

// StartPortForwardProfile starts a profile's forward, unless one is running.
func (m *Manager) StartPortForwardProfile(id string) (PortForward, error) {
	i := slices.IndexFunc(m.store.PortForwardProfiles(), func(x PortForwardProfile) bool { return x.ID == id })
	if i < 0 {
		return PortForward{}, fmt.Errorf("no profile %s", id)
	}
	p := m.store.PortForwardProfiles()[i]
	for _, f := range m.PortForwards() {
		if f.ProfileID != id {
			continue
		}
		if f.State != "stopped" && f.State != "failed" {
			return f, nil // already running
		}
		m.StopPortForward(f.ID) // a forward that ended: start a new one
	}
	f, err := m.StartPortForward(p.request())
	if err != nil {
		m.pfErrors.set(id, err.Error())
	} else {
		m.pfErrors.set(id, "")
	}
	m.emitForwards()
	return f, err
}

// StopPortForwardProfile stops the forward a profile started.
func (m *Manager) StopPortForwardProfile(id string) {
	for _, f := range m.PortForwards() {
		if f.ProfileID == id {
			m.StopPortForward(f.ID)
		}
	}
}

// startProfilesOf starts the auto-start profiles of a cluster that just connected.
func (m *Manager) startProfilesOf(cluster string) {
	if m.store == nil {
		return
	}
	for _, p := range m.store.PortForwardProfiles() {
		if p.AutoStart && p.Cluster == cluster {
			if _, err := m.StartPortForwardProfile(p.ID); err != nil {
				slog.Warn("profile did not start", "profile", p.Name, "cluster", cluster, "error", err)
			}
		}
	}
}
