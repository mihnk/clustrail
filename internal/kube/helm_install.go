package kube

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"helm.sh/helm/v4/pkg/action"
	chartv2 "helm.sh/helm/v4/pkg/chart/v2"
	"helm.sh/helm/v4/pkg/chart/v2/loader"
	"helm.sh/helm/v4/pkg/cli"
	helmkube "helm.sh/helm/v4/pkg/kube"
	releasev1 "helm.sh/helm/v4/pkg/release/v1"
	repov1 "helm.sh/helm/v4/pkg/repo/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/yaml"
)

// Installing a chart from one of this machine's Helm repositories, and
// uninstalling a release. Like upgrades, an install is previewed with a
// server-side dry run first.

// HelmChartEntry is a chart in a local repository index.
type HelmChartEntry struct {
	Repo        string             `json:"repo"`
	Name        string             `json:"name"`
	Version     string             `json:"version"`
	AppVersion  string             `json:"appVersion,omitempty"`
	Description string             `json:"description,omitempty"`
	Deprecated  bool               `json:"deprecated,omitempty"`
	Versions    []HelmChartVersion `json:"versions"`
}

type HelmChartSearch struct {
	Charts []HelmChartEntry `json:"charts"`
	// Note says why the list is empty or short (no repositories, an index not downloaded).
	Note string `json:"note,omitempty"`
}

type HelmInstallRequest struct {
	Cluster   string `json:"cluster"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Repo      string `json:"repo"`
	Chart     string `json:"chart"`
	Version   string `json:"version"`
	// Values is the user-supplied values YAML ("" or "{}": the chart's defaults).
	Values          string `json:"values"`
	CreateNamespace bool   `json:"createNamespace"`
	Wait            bool   `json:"wait"`
	Atomic          bool   `json:"atomic"`
	TimeoutSec      int    `json:"timeoutSec"`
}

// HelmInstallPlan is HelmUpgradePlan for an install; RenderedOnly says the
// API server did not validate it (the namespace does not exist yet).
type HelmInstallPlan struct {
	HelmUpgradePlan
	RenderedOnly bool `json:"renderedOnly,omitempty"`
}

const maxChartResults = 100

var indexCache struct {
	mu      sync.Mutex
	byPath  map[string]time.Time
	entries map[string][]HelmChartEntry
}

// repoCharts reads a repository index (cached until the file changes).
func repoCharts(repo, path string) ([]HelmChartEntry, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	indexCache.mu.Lock()
	defer indexCache.mu.Unlock()
	if indexCache.byPath == nil {
		indexCache.byPath, indexCache.entries = map[string]time.Time{}, map[string][]HelmChartEntry{}
	}
	if t, ok := indexCache.byPath[path]; ok && t.Equal(st.ModTime()) {
		return indexCache.entries[path], nil
	}
	idx, err := repov1.LoadIndexFile(path)
	if err != nil {
		return nil, err
	}
	var out []HelmChartEntry
	for name, versions := range idx.Entries {
		if len(versions) == 0 {
			continue
		}
		latest := versions[0] // the index is sorted newest first
		e := HelmChartEntry{Repo: repo, Name: name, Version: latest.Version, AppVersion: latest.AppVersion, Description: latest.Description, Deprecated: latest.Deprecated, Versions: []HelmChartVersion{}}
		for _, v := range versions {
			e.Versions = append(e.Versions, HelmChartVersion{Repo: repo, Version: v.Version, AppVersion: v.AppVersion})
			if len(e.Versions) >= 30 {
				break
			}
		}
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	indexCache.byPath[path], indexCache.entries[path] = st.ModTime(), out
	return out, nil
}

// HelmCharts searches the charts of this machine's repositories by name and
// description: names that start with the query first, then other matches.
func HelmCharts(query string) (HelmChartSearch, error) {
	repos, err := HelmRepositories()
	if err != nil {
		return HelmChartSearch{Charts: []HelmChartEntry{}}, err
	}
	if len(repos) == 0 {
		return HelmChartSearch{Charts: []HelmChartEntry{}, Note: "No Helm repositories on this machine. Add one with helm repo add, then helm repo update."}, nil
	}
	q := strings.ToLower(strings.TrimSpace(query))
	dir := helmRepositoryCache()
	var prefix, other []HelmChartEntry
	var missing []string
	for _, r := range repos {
		entries, err := repoCharts(r.Name, filepath.Join(dir, r.Name+"-index.yaml"))
		if err != nil {
			missing = append(missing, r.Name)
			continue
		}
		for _, e := range entries {
			name := strings.ToLower(e.Name)
			switch {
			case q == "" || strings.HasPrefix(name, q):
				prefix = append(prefix, e)
			case strings.Contains(name, q) || strings.Contains(strings.ToLower(e.Description), q):
				other = append(other, e)
			}
		}
	}
	out := HelmChartSearch{Charts: append(prefix, other...)}
	if len(out.Charts) > maxChartResults {
		out.Charts = out.Charts[:maxChartResults]
	}
	if len(missing) > 0 {
		out.Note = "No downloaded index for " + strings.Join(missing, ", ") + " (helm repo update)."
	}
	return out, nil
}

// locateChart downloads (or finds in Helm's cache) a chart version from a
// repository in repositories.yaml, with that repository's credentials.
func locateChart(repo, chart, version string) (*chartv2.Chart, error) {
	repos, err := helmRepoEntries()
	if err != nil {
		return nil, err
	}
	for _, r := range repos {
		if r.Name != repo {
			continue
		}
		opts := action.ChartPathOptions{RepoURL: r.URL, Version: version, Username: r.Username, Password: r.Password, CaFile: r.CAFile, CertFile: r.CertFile, KeyFile: r.KeyFile, InsecureSkipTLSVerify: r.InsecureSkipTLSVerify, PassCredentialsAll: r.PassCredentialsAll}
		path, err := opts.LocateChart(chart, cli.New())
		if err != nil {
			return nil, fmt.Errorf("download %s %s from %s: %w", chart, version, repo, err)
		}
		return loader.Load(path)
	}
	return nil, fmt.Errorf("no Helm repository named %q on this machine", repo)
}

// HelmChartDefaults is a chart version's values.yaml, as the chart ships it.
func HelmChartDefaults(repo, chart, version string) (string, error) {
	ch, err := locateChart(repo, chart, version)
	if err != nil {
		return "", err
	}
	for _, f := range ch.Raw {
		if f.Name == "values.yaml" {
			return string(f.Data), nil
		}
	}
	return toYAML(ch.Values, "# the chart has no default values\n"), nil
}

func parseInstallValues(text string) (map[string]any, error) {
	if len(text) > maxManifestBytes {
		return nil, fmt.Errorf("values are larger than %d MiB", maxManifestBytes>>20)
	}
	vals := map[string]any{}
	if strings.TrimSpace(text) == "" {
		return vals, nil
	}
	if err := yaml.Unmarshal([]byte(text), &vals); err != nil {
		return nil, fmt.Errorf("values: %w", err)
	}
	if vals == nil {
		vals = map[string]any{}
	}
	return vals, nil
}

func (r HelmInstallRequest) check() error {
	if r.Namespace == "" || r.Name == "" || r.Repo == "" || r.Chart == "" {
		return fmt.Errorf("namespace, release name, repository and chart are required")
	}
	return nil
}

func newInstall(cfg *action.Configuration, req HelmInstallRequest) *action.Install {
	in := action.NewInstall(cfg)
	in.Namespace = req.Namespace
	in.ReleaseName = req.Name
	in.CreateNamespace = req.CreateNamespace
	in.Timeout = time.Duration(max(req.TimeoutSec, 30)) * time.Second
	in.RollbackOnFailure = req.Atomic
	in.WaitStrategy = helmkube.HookOnlyStrategy
	if req.Wait || req.Atomic {
		in.WaitStrategy = helmkube.StatusWatcherStrategy
	}
	return in
}

// PlanHelmInstall renders the install with a server-side dry run. When the
// namespace does not exist yet (and will be created), the API server cannot
// validate namespaced objects, so the chart is only rendered and the plan
// says so. Nothing is changed, so read-only contexts may plan.
func (m *Manager) PlanHelmInstall(req HelmInstallRequest) (HelmInstallPlan, error) {
	if err := req.check(); err != nil {
		return HelmInstallPlan{}, err
	}
	c, err := m.conn(req.Cluster)
	if err != nil {
		return HelmInstallPlan{}, err
	}
	vals, err := parseInstallValues(req.Values)
	if err != nil {
		return HelmInstallPlan{}, err
	}
	ch, err := locateChart(req.Repo, req.Chart, req.Version)
	if err != nil {
		return HelmInstallPlan{}, err
	}
	cfg, err := helmConfig(c, req.Namespace)
	if err != nil {
		return HelmInstallPlan{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	renderedOnly := false
	if _, err := c.client.CoreV1().Namespaces().Get(ctx, req.Namespace, metav1.GetOptions{}); apierrors.IsNotFound(err) {
		if !req.CreateNamespace {
			return HelmInstallPlan{}, fmt.Errorf("namespace %s does not exist; choose to create it", req.Namespace)
		}
		renderedOnly = true
	}
	in := newInstall(cfg, req)
	in.DryRunStrategy = action.DryRunServer
	if renderedOnly {
		in.DryRunStrategy = action.DryRunClient
	}
	in.WaitStrategy = helmkube.HookOnlyStrategy
	in.HideSecret = false
	out, err := in.RunWithContext(ctx, ch, vals)
	if err != nil {
		return HelmInstallPlan{}, err
	}
	next, ok := out.(*releasev1.Release)
	if !ok {
		return HelmInstallPlan{}, fmt.Errorf("unexpected dry-run result")
	}
	plan := HelmInstallPlan{RenderedOnly: renderedOnly, HelmUpgradePlan: HelmUpgradePlan{
		Chart: ch.Metadata.Name, Version: ch.Metadata.Version, AppVersion: ch.Metadata.AppVersion,
		Objects: diffManifests("", next.Manifest, req.Namespace), Hooks: len(next.Hooks), ValueKeys: changedKeys(nil, vals),
	}}
	if next.Info != nil {
		plan.Notes = next.Info.Notes
	}
	return plan, nil
}

// InstallRelease runs `helm install` with the bundled Helm SDK as a job.
func (m *Manager) InstallRelease(req HelmInstallRequest) (string, error) {
	c, err := m.writable(req.Cluster)
	if err != nil {
		return "", err
	}
	if err := req.check(); err != nil {
		return "", err
	}
	vals, err := parseInstallValues(req.Values)
	if err != nil {
		return "", err
	}
	ch, err := locateChart(req.Repo, req.Chart, req.Version)
	if err != nil {
		return "", err
	}
	cfg, err := helmConfig(c, req.Namespace)
	if err != nil {
		return "", err
	}
	in := newInstall(cfg, req)
	in.Description = fmt.Sprintf("Install %s %s (Clustrail)", ch.Metadata.Name, ch.Metadata.Version)
	jobID := fmt.Sprintf("helm-in-%s-%s-%s-%d", req.Cluster, req.Namespace, req.Name, time.Now().UnixMilli())
	job := m.jobReg().start(jobID, "Installing "+req.Name, req.Cluster, nil)
	detail := fmt.Sprintf("%s %s", ch.Metadata.Name, ch.Metadata.Version)
	if in.WaitStrategy == helmkube.StatusWatcherStrategy {
		detail += " · waiting for resources"
	}
	job.progress(0.2, detail)
	safeGo("Helm install", func(err error) { helmOutcome(job, cfg, req.Name, 0, err) }, func() {
		ctx, cancel := context.WithTimeout(context.Background(), in.Timeout+time.Minute)
		defer cancel()
		if _, err := in.RunWithContext(ctx, ch, vals); err != nil {
			helmOutcome(job, cfg, req.Name, 0, err)
			return
		}
		job.succeed("revision 1 deployed")
	})
	return jobID, nil
}

// UninstallRelease runs `helm uninstall` as a job; keepHistory keeps the
// release's records (helm uninstall --keep-history).
func (m *Manager) UninstallRelease(cluster, ns, name string, keepHistory bool) (string, error) {
	c, err := m.writable(cluster)
	if err != nil {
		return "", err
	}
	cfg, err := helmConfig(c, ns)
	if err != nil {
		return "", err
	}
	un := action.NewUninstall(cfg)
	un.KeepHistory = keepHistory
	un.Timeout = 5 * time.Minute
	un.WaitStrategy = helmkube.HookOnlyStrategy
	un.Description = "Uninstalled by Clustrail"
	jobID := fmt.Sprintf("helm-un-%s-%s-%s-%d", cluster, ns, name, time.Now().UnixMilli())
	job := m.jobReg().start(jobID, "Uninstalling "+name, cluster, nil)
	job.progress(0.2, "deleting the release's objects")
	safeGo("Helm uninstall", func(err error) { job.fail(err) }, func() {
		res, err := un.Run(name)
		if err != nil {
			job.fail(err)
			return
		}
		msg := "uninstalled"
		if keepHistory {
			msg += "; history kept"
		}
		if res != nil && res.Info != "" {
			msg += " · " + res.Info
		}
		job.succeed(msg)
	})
	return jobID, nil
}
