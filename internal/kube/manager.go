package kube

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// Manager owns the kubeconfig view, per-context settings and one connection
// per connected context. All methods are safe for concurrent use.
type Manager struct {
	store *Store
	emit  Emitter
	ctx   context.Context

	mu       sync.Mutex
	kc       *Kubeconfig
	state    map[string]*Cluster // by context name
	conns    map[string]*clusterConn
	hidden   map[string]bool
	attempts map[string]int
	streams  streams
}

func NewManager(ctx context.Context, store *Store, emit Emitter) *Manager {
	m := &Manager{
		store: store, emit: emit, ctx: ctx,
		state: map[string]*Cluster{}, conns: map[string]*clusterConn{}, hidden: map[string]bool{}, attempts: map[string]int{},
		streams: streams{logs: map[string]*logStream{}, exec: map[string]*execSession{}},
	}
	m.reload()
	go m.watchKubeconfig()
	return m
}

// reload re-reads the kubeconfig files and refreshes the context list. Known
// contexts keep their connection; removed ones are disconnected.
func (m *Manager) reload() {
	kc := LoadKubeconfig(m.store.ExtraKubeconfigs())
	names := make([]string, 0, len(kc.Contexts))
	for _, c := range kc.Contexts {
		names = append(names, c.Name)
	}
	if !m.store.FirstRunDone() {
		_ = m.store.MarkKnown(names)
	}

	m.mu.Lock()
	m.kc = kc
	present := map[string]bool{}
	ids := clusterIDs(kc.Contexts)
	for _, c := range kc.Contexts {
		id := ids[c.Name]
		present[id] = true
		cs, _ := m.store.Settings(c.Name, c.DisplayName)
		st := m.state[id]
		if st == nil {
			st = &Cluster{ID: id, Connection: Disconnected}
			m.state[id] = st
		}
		st.Name, st.Context = c.DisplayName, c.Name
		if id != slug(c.DisplayName) {
			st.Name = c.Name
		}
		st.Env, st.Protected, st.ReadOnly = cs.Env, cs.Protected, cs.ReadOnly
		st.Server, st.Auth, st.Source = c.Server, c.Auth, c.Source
		m.hidden[id] = cs.Hidden
	}
	var gone []*clusterConn
	for name := range m.state {
		if !present[name] {
			delete(m.state, name)
			if conn := m.conns[name]; conn != nil {
				gone = append(gone, conn)
				delete(m.conns, name)
			}
		}
	}
	m.mu.Unlock()
	for _, c := range gone {
		c.stop()
	}
	m.emitClusters()
}

// slug makes an ID the frontend can join with "/" (EKS context names are ARNs containing "/").
func slug(s string) string {
	return strings.NewReplacer("/", "-", " ", "-", "|", "-").Replace(s)
}

// clusterIDs gives every context a stable ID: its display name, or the full
// context name when two contexts share a display name.
func clusterIDs(contexts []KubeContext) map[string]string {
	count := map[string]int{}
	for _, c := range contexts {
		count[slug(c.DisplayName)]++
	}
	ids := map[string]string{}
	for _, c := range contexts {
		if id := slug(c.DisplayName); count[id] == 1 {
			ids[c.Name] = id
		} else {
			ids[c.Name] = slug(c.Name)
		}
	}
	return ids
}

func (m *Manager) watchKubeconfig() {
	t := time.NewTicker(3 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-t.C:
			m.mu.Lock()
			changed := m.kc.Changed(m.store.ExtraKubeconfigs())
			m.mu.Unlock()
			if changed {
				m.reload()
			}
		}
	}
}

// ClusterList is what the Connections view and the sidebar render.
type ClusterList struct {
	Clusters    []Cluster          `json:"clusters"`
	Discovered  []Cluster          `json:"discovered"`
	Sources     []KubeconfigSource `json:"sources"`
	Forbidden   []Forbidden        `json:"forbidden"`
	Controllers []Controller       `json:"controllers"`
	Selected    []string           `json:"selected"`
}

func (m *Manager) List() ClusterList {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := ClusterList{Clusters: []Cluster{}, Discovered: []Cluster{}, Sources: m.kc.Sources, Forbidden: []Forbidden{}, Controllers: []Controller{}, Selected: m.store.Selected()}
	for name, c := range m.state {
		if m.hidden[name] {
			continue
		}
		if m.store.IsNew(c.Context) {
			out.Discovered = append(out.Discovered, *c)
			continue
		}
		out.Clusters = append(out.Clusters, *c)
		if conn := m.conns[name]; conn != nil {
			out.Forbidden = append(out.Forbidden, conn.forbidden...)
			if conn.gitops != nil {
				out.Controllers = append(out.Controllers, conn.gitops.controller())
			}
		}
	}
	order := map[Environment]int{EnvProd: 0, EnvStg: 1, EnvDev: 2}
	sort.Slice(out.Clusters, func(i, j int) bool {
		a, b := out.Clusters[i], out.Clusters[j]
		if order[a.Env] != order[b.Env] {
			return order[a.Env] < order[b.Env]
		}
		return a.Name < b.Name
	})
	return out
}

func (m *Manager) emitClusters() { m.emit.Emit(EventClusters, m.List()) }

func (m *Manager) setState(id string, f func(c *Cluster)) {
	m.mu.Lock()
	if c := m.state[id]; c != nil {
		f(c)
	}
	m.mu.Unlock()
	m.emitClusters()
}

func (m *Manager) restConfig(id string) (*rest.Config, *clientcmdapi.AuthInfo, error) {
	m.mu.Lock()
	kc := m.kc
	name := ""
	if st := m.state[id]; st != nil {
		name = st.Context
	}
	m.mu.Unlock()
	ctx, ok := kc.Merged.Contexts[name]
	if !ok {
		return nil, nil, fmt.Errorf("context %q not found in kubeconfig", id)
	}
	id = name
	auth := kc.Merged.AuthInfos[ctx.AuthInfo]
	cfg, err := clientcmd.NewNonInteractiveClientConfig(*kc.Merged, id, &clientcmd.ConfigOverrides{}, nil).ClientConfig()
	if err != nil {
		return nil, auth, err
	}
	if cfg.ExecProvider != nil {
		// Never prompt: expired credentials surface as an error with the command to run.
		cfg.ExecProvider.InteractiveMode = clientcmdapi.NeverExecInteractiveMode
	}
	cfg.Timeout = 20 * time.Second
	return cfg, auth, nil
}

// Connect connects a context in the background; progress arrives as cluster events.
func (m *Manager) Connect(id string) {
	m.mu.Lock()
	if _, ok := m.state[id]; !ok || m.conns[id] != nil {
		m.mu.Unlock()
		return
	}
	m.mu.Unlock()
	m.setState(id, func(c *Cluster) { c.Connection, c.Error, c.AuthHint = Connecting, "", nil })
	go m.connect(id)
}

func (m *Manager) connect(id string) {
	cfg, auth, err := m.restConfig(id)
	fail := func(err error) {
		state := classifyError(err)
		m.setState(id, func(c *Cluster) {
			c.Connection, c.Error, c.LatencyMs = state, errText(err), nil
			if state == AuthExpired {
				plugin := ""
				for _, kctx := range m.kc.Contexts {
					if kctx.Name == c.Context {
						plugin = kctx.AuthPlugin
					}
				}
				if cmd := ReauthCommand(plugin, auth); cmd != "" {
					c.AuthHint = &AuthHint{Plugin: plugin, Command: cmd}
				}
			}
		})
	}
	if err != nil {
		fail(err)
		return
	}
	conn, err := newClusterConn(id, cfg, func() Environment { return m.envOf(id) }, m.emit, func(s ConnectionState, err error) { m.onConnState(id, s, err) })
	if err != nil {
		fail(err)
		return
	}
	ctx, cancel := context.WithTimeout(m.ctx, 25*time.Second)
	info, err := conn.probe(ctx)
	cancel()
	if err != nil {
		fail(err)
		return
	}
	m.mu.Lock()
	if m.conns[id] != nil { // connected twice
		m.mu.Unlock()
		return
	}
	m.conns[id] = conn
	m.mu.Unlock()
	if err := conn.start(m.ctx, info.Identity, info.Metrics); err != nil {
		fail(err)
		return
	}
	go conn.probeLoop(conn.ctx, func(ms int, err error) { m.onProbe(id, ms, err) })
	m.setState(id, func(c *Cluster) {
		c.Connection, c.Error, c.AuthHint, c.Stale = Connected, "", nil, nil
		c.LatencyMs = ptr(info.LatencyMs)
		c.Version, c.Identity = info.Version, info.Identity
		c.Summary = ptr(info.Summary)
		c.LastConnected = "now"
		if info.Metrics {
			c.Metrics = ptr("metrics-server")
		} else {
			c.Metrics = nil
		}
	})
	// The region comes from node labels once the node cache filled.
	go func() {
		for range 20 {
			time.Sleep(500 * time.Millisecond)
			if r := conn.region(); r != "" {
				m.setState(id, func(c *Cluster) { c.Summary = ptr(info.Summary + " · " + r) })
				return
			}
		}
	}()
}

func (m *Manager) envOf(id string) Environment {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c := m.state[id]; c != nil {
		return c.Env
	}
	return EnvDev
}

// onConnState handles a watch error: rows stay but are marked stale until a probe succeeds.
func (m *Manager) onConnState(id string, s ConnectionState, err error) {
	if s != Reconnecting {
		return
	}
	m.mu.Lock()
	m.attempts[id]++
	attempt := m.attempts[id]
	m.mu.Unlock()
	m.setState(id, func(c *Cluster) {
		if c.Connection == Connected || c.Connection == Reconnecting {
			if c.Stale == nil {
				c.Stale = &Stale{Since: time.Now().UnixMilli()}
			}
			c.Connection, c.Error = Reconnecting, errText(err)
			c.Stale.Attempt, c.Stale.NextRetrySec = attempt, int(probeInterval.Seconds())
		}
	})
}

func (m *Manager) onProbe(id string, ms int, err error) {
	m.mu.Lock()
	cur := m.state[id]
	wasStale := cur != nil && cur.Connection == Reconnecting
	if err == nil {
		m.attempts[id] = 0
	}
	m.mu.Unlock()
	if err != nil {
		if classifyError(err) == AuthExpired {
			m.setState(id, func(c *Cluster) { c.Connection, c.Error = AuthExpired, errText(err) })
		} else {
			m.onConnState(id, Reconnecting, err)
		}
		return
	}
	if wasStale || (cur != nil && (cur.LatencyMs == nil || *cur.LatencyMs != ms)) {
		m.setState(id, func(c *Cluster) {
			c.LatencyMs = ptr(ms)
			if c.Connection == Reconnecting {
				c.Connection, c.Stale, c.Error = Connected, nil, ""
			}
		})
	}
}

// Disconnect stops the informers and drops the cache of a context.
func (m *Manager) Disconnect(id string) {
	m.mu.Lock()
	conn := m.conns[id]
	delete(m.conns, id)
	m.mu.Unlock()
	if conn != nil {
		conn.stop()
	}
	for _, kind := range []string{"pods", "deployments", "nodes", "helm", "gitops"} {
		m.emit.Emit(EventDelta, Delta{Cluster: id, Kind: kind, Reset: true, Upserts: []any{}, Deletes: []string{}})
	}
	m.setState(id, func(c *Cluster) {
		c.Connection, c.LatencyMs, c.Stale, c.Error = Disconnected, nil, nil, ""
		c.LastConnected = time.Now().Format("15:04")
	})
}

// UpdateSettings stores group and protection for a context.
func (m *Manager) UpdateSettings(id string, env Environment, protected, readOnly bool) error {
	m.mu.Lock()
	cur, ok := m.state[id]
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("unknown context %q", id)
	}
	if err := m.store.SetSettings(cur.Context, ContextSettings{Env: env, Protected: protected, ReadOnly: readOnly, Hidden: m.hidden[id]}); err != nil {
		return err
	}
	envChanged := cur.Env != env
	m.setState(id, func(c *Cluster) { c.Env, c.Protected, c.ReadOnly = env, protected, readOnly })
	if envChanged {
		// Rows carry the environment; resend them.
		m.mu.Lock()
		conn := m.conns[id]
		m.mu.Unlock()
		if conn != nil {
			conn.mu.Lock()
			conn.resetSent = map[string]bool{}
			conn.mu.Unlock()
		}
	}
	return nil
}

// Hide hides a context in Clustrail; the kubeconfig is not modified.
func (m *Manager) Hide(id string) error {
	m.Disconnect(id)
	m.mu.Lock()
	cur := m.state[id]
	m.hidden[id] = true
	m.mu.Unlock()
	if cur == nil {
		return nil
	}
	err := m.store.SetSettings(cur.Context, ContextSettings{Env: cur.Env, Protected: cur.Protected, ReadOnly: cur.ReadOnly, Hidden: true})
	m.emitClusters()
	return err
}

// Add accepts a newly discovered context with its group and protection, then connects.
func (m *Manager) Add(id string, env Environment, protected, readOnly bool) error {
	if err := m.UpdateSettings(id, env, protected, readOnly); err != nil {
		return err
	}
	m.Connect(id)
	return nil
}

func (m *Manager) SetSelected(ids []string) error { return m.store.SetSelected(ids) }

// AutoConnect connects the contexts that were selected when the app last quit.
func (m *Manager) AutoConnect() {
	for _, id := range m.store.Selected() {
		m.Connect(id)
	}
}

func (m *Manager) conn(id string) (*clusterConn, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.conns[id]
	if c == nil {
		return nil, fmt.Errorf("%s is not connected", id)
	}
	return c, nil
}

// Snapshot returns all rows of every connected context, for a fresh frontend.
func (m *Manager) Snapshot() Snapshot {
	list := m.List()
	snap := Snapshot{Clusters: list.Clusters, Pods: []PodRow{}, Deployments: []DeploymentRow{}, Nodes: []NodeRow{}, Helm: []HelmRelease{}, GitOps: []GitOpsObject{}}
	m.mu.Lock()
	conns := make([]*clusterConn, 0, len(m.conns))
	for _, c := range m.conns {
		conns = append(conns, c)
	}
	m.mu.Unlock()
	now := time.Now()
	for _, c := range conns {
		if !c.synced() {
			continue
		}
		env := c.env()
		snap.Pods = append(snap.Pods, c.allPodRows(env, now)...)
		snap.Deployments = append(snap.Deployments, c.allDeploymentRows(env, now)...)
		snap.Nodes = append(snap.Nodes, c.allNodeRows(env, now)...)
		if c.helm != nil && c.helm.lister != nil {
			snap.Helm = append(snap.Helm, c.helm.releases()...)
		}
		if c.gitops != nil && len(c.gitops.listers) > 0 {
			snap.GitOps = append(snap.GitOps, c.gitops.objects()...)
		}
	}
	return snap
}

// Shutdown stops every connection.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	conns := m.conns
	m.conns = map[string]*clusterConn{}
	m.mu.Unlock()
	for _, c := range conns {
		c.stop()
	}
}

// AddKubeconfig adds a kubeconfig file to the loading chain and re-reads the
// contexts. Contexts it brings appear as New.
func (m *Manager) AddKubeconfig(path string) error {
	if _, err := clientcmd.LoadFromFile(path); err != nil {
		return fmt.Errorf("not a kubeconfig file: %w", err)
	}
	if err := m.store.AddKubeconfig(path); err != nil {
		return err
	}
	m.reload()
	return nil
}
