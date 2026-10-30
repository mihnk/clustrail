package kube

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/informers"
	listerscorev1 "k8s.io/client-go/listers/core/v1"
	"k8s.io/client-go/tools/cache"
	"sigs.k8s.io/yaml"
)

type HelmRevision struct {
	Rev            int    `json:"rev"`
	Status         string `json:"status"`
	ChartVersion   string `json:"chartVersion"`
	AppVersion     string `json:"appVersion"`
	UpdatedSeconds int64  `json:"updatedSeconds"`
	Description    string `json:"description"`
}

type HelmResource struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

type HelmRelease struct {
	ID             string         `json:"id"`
	Name           string         `json:"name"`
	Namespace      string         `json:"namespace"`
	Cluster        string         `json:"cluster"`
	Env            Environment    `json:"env"`
	Status         string         `json:"status"`
	Health         Health         `json:"health"`
	Chart          string         `json:"chart"`
	ChartVersion   string         `json:"chartVersion"`
	AppVersion     string         `json:"appVersion"`
	Revision       int            `json:"revision"`
	UpdatedSeconds int64          `json:"updatedSeconds"`
	RepoKnown      bool           `json:"repoKnown"`
	History        []HelmRevision `json:"history"`
	Values         string         `json:"values"`
	Notes          string         `json:"notes"`
	Resources      []HelmResource `json:"resources"`
}

// storedRelease is the subset of Helm's release record (helm.sh/helm/v3/pkg/release) Clustrail reads.
type storedRelease struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Version   int    `json:"version"`
	Info      struct {
		Status       string    `json:"status"`
		LastDeployed time.Time `json:"last_deployed"`
		Description  string    `json:"description"`
		Notes        string    `json:"notes"`
	} `json:"info"`
	Chart struct {
		Metadata struct {
			Name       string `json:"name"`
			Version    string `json:"version"`
			AppVersion string `json:"appVersion"`
		} `json:"metadata"`
		// The chart's own values.yaml defaults.
		Values map[string]any `json:"values"`
	} `json:"chart"`
	Config   map[string]any `json:"config"`
	Manifest string         `json:"manifest"`
	Hooks    []struct {
		Name   string   `json:"name"`
		Kind   string   `json:"kind"`
		Events []string `json:"events"`
	} `json:"hooks"`
}

// decodeRelease decodes the "release" field of a Helm storage Secret:
// base64, then gzip, then JSON.
func decodeRelease(data []byte) (*storedRelease, error) {
	raw, err := base64.StdEncoding.DecodeString(string(data))
	if err != nil {
		return nil, err
	}
	if len(raw) > 2 && raw[0] == 0x1f && raw[1] == 0x8b {
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		if raw, err = io.ReadAll(zr); err != nil {
			return nil, err
		}
	}
	var r storedRelease
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

func helmHealth(status string) Health {
	switch {
	case status == "failed":
		return Failed
	case strings.HasPrefix(status, "pending") || status == "uninstalling":
		return Progressing
	}
	return Healthy
}

var secretLike = []string{"password", "secret", "token", "apikey", "api_key", "privatekey", "private_key", "credentials"}

// redact replaces values whose key looks like a credential.
func redact(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			lk := strings.ToLower(k)
			hit := false
			for _, s := range secretLike {
				if strings.Contains(lk, s) {
					hit = true
				}
			}
			if hit {
				if _, isMap := val.(map[string]any); !isMap {
					out[k] = "[redacted by Clustrail]"
					continue
				}
			}
			out[k] = redact(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i := range t {
			out[i] = redact(t[i])
		}
		return out
	}
	return v
}

func manifestResources(manifest string) []HelmResource {
	var out []HelmResource
	for _, doc := range strings.Split(manifest, "\n---") {
		var m struct {
			Kind     string `json:"kind"`
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
		}
		if yaml.Unmarshal([]byte(doc), &m) == nil && m.Kind != "" {
			out = append(out, HelmResource{Kind: m.Kind, Name: m.Metadata.Name})
		}
	}
	return out
}

// chartInLocalRepoCache reports whether a chart name appears in a Helm repo
// cached on this machine, i.e. an upgrade source is configured.
var chartCache struct {
	once  sync.Once
	names map[string]bool
}

func helmRepositoryCache() string {
	if dir := os.Getenv("HELM_REPOSITORY_CACHE"); dir != "" {
		return dir
	}
	if c, err := os.UserCacheDir(); err == nil {
		return filepath.Join(c, "helm", "repository")
	}
	return ""
}

func chartInLocalRepoCache(chart string) bool {
	chartCache.once.Do(func() { chartCache.names = cachedChartNames(helmRepositoryCache()) })
	return chartCache.names[chart]
}

// cachedChartNames collects chart names from Helm's repository cache. Helm
// writes <repo>-charts.txt (one name per line) next to each index; without it
// the index is scanned for its entry keys. Indexes reach tens of MB (every
// version of every chart), so they are never fully parsed.
func cachedChartNames(dir string) map[string]bool {
	names := map[string]bool{}
	if dir == "" {
		return names
	}
	indexes, _ := filepath.Glob(filepath.Join(dir, "*-index.yaml"))
	for _, index := range indexes {
		if list, err := os.Open(strings.TrimSuffix(index, "-index.yaml") + "-charts.txt"); err == nil {
			sc := bufio.NewScanner(list)
			for sc.Scan() {
				if n := strings.TrimSpace(sc.Text()); n != "" {
					names[n] = true
				}
			}
			list.Close()
			continue
		}
		f, err := os.Open(index)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
		inEntries := false
		for sc.Scan() {
			line := sc.Text()
			switch {
			case line == "entries:":
				inEntries = true
			case inEntries && len(line) > 0 && line[0] != ' ' && line[0] != '-':
				inEntries = false // next top-level key
			case inEntries && strings.HasPrefix(line, "  ") && len(line) > 2 && line[2] != ' ' && line[2] != '-' && strings.HasSuffix(line, ":"):
				names[strings.Trim(strings.TrimSuffix(line[2:], ":"), `"'`)] = true
			}
		}
		f.Close()
	}
	return names
}

// helmWatcher reads Helm release Secrets (label owner=helm).
type helmWatcher struct {
	c        *clusterConn
	identity string
	lister   listerscorev1.SecretLister
	synced   cache.InformerSynced
	mu       sync.Mutex
	dirty    bool
	sentAll  bool
}

func newHelmWatcher(c *clusterConn, identity string) *helmWatcher {
	return &helmWatcher{c: c, identity: identity}
}

func (h *helmWatcher) start(ctx context.Context) {
	ns, ok := h.c.scope(ctx, h.identity, "", "secrets", "secrets (Helm releases)")
	if !ok {
		return
	}
	mark := func(any) { h.mu.Lock(); h.dirty = true; h.mu.Unlock() }
	var stop func()
	if pollMode.Load() {
		// Poll mode: Helm's storage Secrets are listed like everything else.
		idx, synced := h.c.pollSource(ctx, func(ctx context.Context) ([]any, error) {
			l, err := h.c.client.CoreV1().Secrets(ns).List(ctx, metav1.ListOptions{LabelSelector: "owner=helm"})
			return items(l, err, func() []corev1.Secret { return l.Items })
		}, nil, mark)
		h.lister, h.synced, stop = listerscorev1.NewSecretLister(idx), synced, func() {}
	} else {
		f := informers.NewSharedInformerFactoryWithOptions(h.c.client, 0, informers.WithNamespace(ns), informers.WithTweakListOptions(func(o *metav1.ListOptions) {
			o.LabelSelector = "owner=helm"
		}))
		inf := f.Core().V1().Secrets()
		h.lister = inf.Lister()
		h.synced = inf.Informer().HasSynced
		_, _ = inf.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{AddFunc: mark, UpdateFunc: func(_, o any) { mark(o) }, DeleteFunc: mark})
		f.Start(ctx.Done())
		stop = f.Shutdown
	}
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				stop()
				return
			case <-t.C:
				h.flush()
			}
		}
	}()
}

func (h *helmWatcher) flush() {
	if h.lister == nil || !h.synced() {
		return
	}
	h.mu.Lock()
	if !h.dirty && h.sentAll {
		h.mu.Unlock()
		return
	}
	h.dirty, h.sentAll = false, true
	h.mu.Unlock()
	h.c.emit.Emit(EventDelta, Delta{Cluster: h.c.id, Kind: "helm", Reset: true, Upserts: toAny(h.releases()), Deletes: []string{}})
}

// releases groups the storage Secrets by release; the newest revision is the row.
func (h *helmWatcher) releases() []HelmRelease {
	secrets, _ := h.lister.List(labels.Everything())
	type key struct{ ns, name string }
	byRelease := map[key][]*storedRelease{}
	for _, s := range secrets {
		if s.Type != corev1.SecretType("helm.sh/release.v1") {
			continue
		}
		r, err := decodeRelease(s.Data["release"])
		if err != nil {
			continue
		}
		if r.Namespace == "" {
			r.Namespace = s.Namespace
		}
		k := key{r.Namespace, r.Name}
		byRelease[k] = append(byRelease[k], r)
	}
	now := time.Now()
	env := h.c.env()
	out := make([]HelmRelease, 0, len(byRelease))
	for k, revs := range byRelease {
		sort.Slice(revs, func(i, j int) bool { return revs[i].Version > revs[j].Version })
		cur := revs[0]
		values := ""
		if len(cur.Config) > 0 {
			b, _ := yaml.Marshal(redact(cur.Config))
			values = string(b)
		} else {
			values = "# no user-supplied values (chart defaults)\n"
		}
		rel := HelmRelease{
			ID:             h.c.id + "/" + k.ns + "/" + k.name,
			Name:           k.name,
			Namespace:      k.ns,
			Cluster:        h.c.id,
			Env:            env,
			Status:         cur.Info.Status,
			Health:         helmHealth(cur.Info.Status),
			Chart:          cur.Chart.Metadata.Name,
			ChartVersion:   cur.Chart.Metadata.Version,
			AppVersion:     cur.Chart.Metadata.AppVersion,
			Revision:       cur.Version,
			UpdatedSeconds: int64(now.Sub(cur.Info.LastDeployed).Seconds()),
			RepoKnown:      chartInLocalRepoCache(cur.Chart.Metadata.Name),
			Values:         values,
			Notes:          cur.Info.Notes,
			Resources:      manifestResources(cur.Manifest),
		}
		for _, r := range revs {
			rel.History = append(rel.History, HelmRevision{
				Rev:            r.Version,
				Status:         r.Info.Status,
				ChartVersion:   r.Chart.Metadata.Version,
				AppVersion:     r.Chart.Metadata.AppVersion,
				UpdatedSeconds: int64(now.Sub(r.Info.LastDeployed).Seconds()),
				Description:    r.Info.Description,
			})
		}
		out = append(out, rel)
	}
	return out
}

type HelmHook struct {
	Name   string   `json:"name"`
	Kind   string   `json:"kind"`
	Events []string `json:"events"`
}

// HelmRevisionDetail is what one stored revision contains.
type HelmRevisionDetail struct {
	Rev      int    `json:"rev"`
	Manifest string `json:"manifest"`
	// User-supplied values (helm get values) and those merged over the chart defaults (--all); redacted.
	Values   string     `json:"values"`
	Computed string     `json:"computed"`
	Hooks    []HelmHook `json:"hooks"`
}

func (h *helmWatcher) revision(ns, name string, rev int) (*storedRelease, error) {
	if h.lister == nil {
		return nil, fmt.Errorf("Helm release Secrets are not readable on %s", h.c.id)
	}
	s, err := h.lister.Secrets(ns).Get("sh.helm.release.v1." + name + ".v" + itoa(rev))
	if err != nil {
		return nil, err
	}
	return decodeRelease(s.Data["release"])
}

// mergeValues overlays user values on chart defaults the way Helm coalesces them:
// maps merge key by key, anything else is replaced.
func mergeValues(base, over map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(over))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range over {
		if bm, ok := out[k].(map[string]any); ok {
			if om, ok := v.(map[string]any); ok {
				out[k] = mergeValues(bm, om)
				continue
			}
		}
		out[k] = v
	}
	return out
}

func toYAML(v map[string]any, empty string) string {
	if len(v) == 0 {
		return empty
	}
	b, err := yaml.Marshal(redact(v))
	if err != nil {
		return err.Error()
	}
	return string(b)
}

// GetHelmRevision returns the stored manifest, values and hooks of one revision.
func (m *Manager) GetHelmRevision(cluster, ns, name string, rev int) (HelmRevisionDetail, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return HelmRevisionDetail{}, err
	}
	if c.helm == nil {
		return HelmRevisionDetail{}, fmt.Errorf("Helm releases are not read on %s", cluster)
	}
	r, err := c.helm.revision(ns, name, rev)
	if err != nil {
		return HelmRevisionDetail{}, err
	}
	d := HelmRevisionDetail{
		Rev:      rev,
		Manifest: r.Manifest,
		Values:   toYAML(r.Config, "# no user-supplied values (chart defaults)\n"),
		Computed: toYAML(mergeValues(r.Chart.Values, r.Config), "# the chart has no values\n"),
		Hooks:    []HelmHook{},
	}
	for _, hk := range r.Hooks {
		d.Hooks = append(d.Hooks, HelmHook{Name: hk.Name, Kind: hk.Kind, Events: hk.Events})
	}
	return d, nil
}

func itoa(i int) string { return strconv.Itoa(i) }

// HelmRepository is one entry of Helm's own repositories.yaml (helm repo add).
type HelmRepository struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

// HelmRepositories lists the repositories the Helm CLI on this machine knows.
// Clustrail reads them to decide whether a chart can be upgraded; it does not change them.
func HelmRepositories() ([]HelmRepository, error) {
	raw, err := os.ReadFile(helmRepositoryConfig())
	if os.IsNotExist(err) {
		return []HelmRepository{}, nil
	}
	if err != nil {
		return nil, err
	}
	var f struct {
		Repositories []HelmRepository `json:"repositories"`
	}
	if err := yaml.Unmarshal(raw, &f); err != nil {
		return nil, err
	}
	if f.Repositories == nil {
		f.Repositories = []HelmRepository{}
	}
	return f.Repositories, nil
}

// helmRepositoryConfig is the path of Helm's repositories.yaml.
func helmRepositoryConfig() string {
	if path := os.Getenv("HELM_REPOSITORY_CONFIG"); path != "" {
		return path
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "repositories.yaml"
	}
	return filepath.Join(dir, "helm", "repositories.yaml")
}
