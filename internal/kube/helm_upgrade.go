package kube

import (
	"context"
	"encoding/base64"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"time"

	"helm.sh/helm/v4/pkg/action"
	chartv2 "helm.sh/helm/v4/pkg/chart/v2"
	"helm.sh/helm/v4/pkg/chart/v2/loader"
	"helm.sh/helm/v4/pkg/cli"
	helmkube "helm.sh/helm/v4/pkg/kube"
	releasev1 "helm.sh/helm/v4/pkg/release/v1"
	repov1 "helm.sh/helm/v4/pkg/repo/v1"
	"sigs.k8s.io/yaml"
)

// Upgrading a release with edited values, and optionally another chart
// version from a repository the Helm CLI knows. The plan is a server-side dry
// run, diffed object by object against the deployed manifest; Secret values
// never leave this file.

// redactedValue is what redact() puts in place of a credential-like value;
// an upgrade that keeps it keeps the live value.
const redactedValue = "[redacted by Clustrail]"

type HelmUpgradeRequest struct {
	Cluster   string `json:"cluster"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	// Values is the user-supplied values YAML ("" or "{}": the chart's defaults).
	Values string `json:"values"`
	// Repo and Version pick another chart version from a repository in
	// repositories.yaml; both empty keep the installed chart.
	Repo       string `json:"repo,omitempty"`
	Version    string `json:"version,omitempty"`
	Wait       bool   `json:"wait"`
	Atomic     bool   `json:"atomic"`
	TimeoutSec int    `json:"timeoutSec"`
}

// HelmChartVersion is a version of the release's chart in a local repository index.
type HelmChartVersion struct {
	Repo       string `json:"repo"`
	Version    string `json:"version"`
	AppVersion string `json:"appVersion,omitempty"`
}

// HelmUpgradeSource is where the upgrade dialog starts.
type HelmUpgradeSource struct {
	Chart      string `json:"chart"`
	Version    string `json:"version"`
	AppVersion string `json:"appVersion"`
	Revision   int    `json:"revision"`
	// Values are the current revision's user-supplied values, credentials redacted.
	Values   string             `json:"values"`
	Defaults string             `json:"defaults"`
	Versions []HelmChartVersion `json:"versions"`
	// VersionsNote says why other versions are not offered, when they are not.
	VersionsNote string `json:"versionsNote,omitempty"`
}

type HelmObjectChange struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
	// Change: changed · added · removed · unchanged.
	Change string `json:"change"`
	Before string `json:"before,omitempty"`
	After  string `json:"after,omitempty"`
}

type HelmUpgradePlan struct {
	Chart      string             `json:"chart"`
	Version    string             `json:"version"`
	AppVersion string             `json:"appVersion"`
	Objects    []HelmObjectChange `json:"objects"`
	Hooks      int                `json:"hooks"`
	Notes      string             `json:"notes,omitempty"`
	// ValueKeys are the top-level value keys that differ from the current revision.
	ValueKeys []string `json:"valueKeys"`
}

func helmConfig(c *clusterConn, ns string) (*action.Configuration, error) {
	cfg := action.NewConfiguration()
	cfg.SetLogger(slog.DiscardHandler)
	if err := cfg.Init(restGetter{cfg: c.rest, namespace: ns}, ns, "secret"); err != nil {
		return nil, err
	}
	// Helm reads the namespace for the release's objects from the kubeconfig
	// loader, which has no cluster here, and would fall back to "default".
	if kc, ok := cfg.KubeClient.(*helmkube.Client); ok {
		kc.Namespace = ns
	}
	return cfg, nil
}

func currentRelease(cfg *action.Configuration, name string) (*releasev1.Release, error) {
	r, err := action.NewGet(cfg).Run(name)
	if err != nil {
		return nil, err
	}
	rel, ok := r.(*releasev1.Release)
	if !ok || rel.Chart == nil {
		return nil, fmt.Errorf("release %s has an unsupported format", name)
	}
	return rel, nil
}

// HelmUpgradeSource reads the release's current values and the chart versions
// the local repository indexes list.
func (m *Manager) HelmUpgradeSource(cluster, ns, name string) (HelmUpgradeSource, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return HelmUpgradeSource{}, err
	}
	cfg, err := helmConfig(c, ns)
	if err != nil {
		return HelmUpgradeSource{}, err
	}
	rel, err := currentRelease(cfg, name)
	if err != nil {
		return HelmUpgradeSource{}, err
	}
	md := rel.Chart.Metadata
	src := HelmUpgradeSource{
		Chart: md.Name, Version: md.Version, AppVersion: md.AppVersion, Revision: rel.Version,
		Values:   toYAML(rel.Config, "{}\n"),
		Defaults: toYAML(rel.Chart.Values, "{}\n"),
		Versions: []HelmChartVersion{},
	}
	if strings.HasPrefix(src.Values, "# values could not be shown") {
		// Editing a comment would upgrade with no values at all.
		return HelmUpgradeSource{}, fmt.Errorf("the release's values cannot be shown for editing: %s", strings.TrimPrefix(strings.TrimSpace(src.Values), "# values could not be shown: "))
	}
	src.Versions, src.VersionsNote = chartVersions(md.Name)
	return src, nil
}

// chartVersions lists up to 30 newest versions of a chart across the local
// repository indexes (helm repo update keeps them current).
func chartVersions(chart string) ([]HelmChartVersion, string) {
	repos, err := HelmRepositories()
	if err != nil {
		return []HelmChartVersion{}, "Helm repositories: " + err.Error()
	}
	if len(repos) == 0 {
		return []HelmChartVersion{}, "No Helm repositories on this machine (helm repo add): only the installed chart can be used."
	}
	dir := helmRepositoryCache()
	out := []HelmChartVersion{}
	for _, r := range repos {
		// Helm writes <repo>-charts.txt next to each index: a cheap check before parsing a large index.
		if list, err := os.ReadFile(filepath.Join(dir, r.Name+"-charts.txt")); err == nil && !containsLine(string(list), chart) {
			continue
		}
		idx, err := repov1.LoadIndexFile(filepath.Join(dir, r.Name+"-index.yaml"))
		if err != nil {
			continue
		}
		for _, v := range idx.Entries[chart] {
			out = append(out, HelmChartVersion{Repo: r.Name, Version: v.Version, AppVersion: v.AppVersion})
			if len(out) >= 30 {
				break
			}
		}
	}
	if len(out) == 0 {
		return out, "The chart is in none of this machine's Helm repositories: only the installed chart can be used."
	}
	return out, ""
}

func (m *Manager) loadChart(req HelmUpgradeRequest, installed *chartv2.Chart) (*chartv2.Chart, error) {
	if req.Repo == "" && req.Version == "" {
		return installed, nil
	}
	repos, err := helmRepoEntries()
	if err != nil {
		return nil, err
	}
	for _, r := range repos {
		if r.Name != req.Repo {
			continue
		}
		opts := action.ChartPathOptions{RepoURL: r.URL, Version: req.Version, Username: r.Username, Password: r.Password, CaFile: r.CAFile, CertFile: r.CertFile, KeyFile: r.KeyFile, InsecureSkipTLSVerify: r.InsecureSkipTLSVerify, PassCredentialsAll: r.PassCredentialsAll}
		settings := cli.New()
		path, err := opts.LocateChart(installed.Metadata.Name, settings)
		if err != nil {
			return nil, fmt.Errorf("download %s %s from %s: %w", installed.Metadata.Name, req.Version, r.Name, err)
		}
		return loader.Load(path)
	}
	return nil, fmt.Errorf("no Helm repository named %q on this machine", req.Repo)
}

// parseUpgradeValues reads the edited YAML and puts live values back where
// the redaction placeholder was kept.
func parseUpgradeValues(text string, live map[string]any) (map[string]any, error) {
	vals := map[string]any{}
	if strings.TrimSpace(text) != "" {
		if err := yaml.Unmarshal([]byte(text), &vals); err != nil {
			return nil, fmt.Errorf("values are not valid YAML: %w", err)
		}
	}
	if vals == nil {
		vals = map[string]any{}
	}
	if err := unredact(vals, live, ""); err != nil {
		return nil, err
	}
	// Never send the placeholder to the cluster as a value.
	if hasPlaceholder(vals) {
		return nil, fmt.Errorf("values still contain %q; type the real values", redactedValue)
	}
	return vals, nil
}

func unredact(v map[string]any, live map[string]any, path string) error {
	for k, val := range v {
		lv, ok := live[k]
		r, err := unredactValue(val, lv, ok, strings.TrimPrefix(path+"."+k, "."))
		if err != nil {
			return err
		}
		v[k] = r
	}
	return nil
}

// unredactValue puts the live value back where the placeholder was kept,
// walking into maps and lists.
func unredactValue(val, live any, liveOK bool, path string) (any, error) {
	switch t := val.(type) {
	case string:
		if t != redactedValue {
			return t, nil
		}
		if !liveOK {
			return nil, fmt.Errorf("%s is %q but the release has no value there to keep; type the value", path, redactedValue)
		}
		return live, nil
	case map[string]any:
		sub, _ := live.(map[string]any)
		return t, unredact(t, sub, path)
	case []any:
		if !hasPlaceholder(t) {
			return t, nil
		}
		ll, _ := live.([]any)
		match, err := matchListItems(t, ll, path)
		if err != nil {
			return nil, err
		}
		for i := range t {
			var lv any
			if match[i] >= 0 {
				lv = ll[match[i]]
			}
			r, err := unredactValue(t[i], lv, match[i] >= 0, fmt.Sprintf("%s[%d]", path, i))
			if err != nil {
				return nil, err
			}
			t[i] = r
		}
		return t, nil
	}
	return val, nil
}

// listIdentityKeys name a list item when edited items are matched to the
// release's items by identity rather than by position.
var listIdentityKeys = []string{"name", "key", "id"}

// matchListItems pairs each edited item with the live item it came from (-1:
// none). An unchanged list pairs by position; otherwise items are paired by a
// name, key or id that every item has and no two share. A secret is never
// moved to an item by guessing: without either, the edit is refused.
func matchListItems(items, live []any, path string) ([]int, error) {
	match := make([]int, len(items))
	if len(items) == len(live) {
		same := true
		for i := range items {
			if !reflect.DeepEqual(items[i], redact(live[i])) {
				same = false
				break
			}
		}
		if same {
			for i := range match {
				match[i] = i
			}
			return match, nil
		}
	}
	for _, key := range listIdentityKeys {
		ids, ok := listIDs(items, key)
		if !ok {
			continue
		}
		liveIDs, ok := listIDs(live, key)
		if !ok {
			continue
		}
		at := make(map[string]int, len(liveIDs))
		for j, id := range liveIDs {
			at[id] = j
		}
		for i, id := range ids {
			if j, found := at[id]; found {
				match[i] = j
			} else {
				match[i] = -1
			}
		}
		return match, nil
	}
	return nil, fmt.Errorf("%s: the list changed and its items have no name, key or id, so the values kept as %q can't be matched to the release's items; type them", path, redactedValue)
}

// listIDs returns each item's value for key when every item is a map with
// that key and no two items share it.
func listIDs(items []any, key string) ([]string, bool) {
	ids := make([]string, len(items))
	seen := make(map[string]bool, len(items))
	for i, it := range items {
		m, ok := it.(map[string]any)
		if !ok {
			return nil, false
		}
		v, ok := m[key]
		if !ok {
			return nil, false
		}
		id := fmt.Sprint(v)
		if seen[id] {
			return nil, false
		}
		seen[id] = true
		ids[i] = id
	}
	return ids, true
}

// hasPlaceholder reports whether the redaction placeholder appears anywhere in v.
func hasPlaceholder(v any) bool {
	switch t := v.(type) {
	case string:
		return t == redactedValue
	case map[string]any:
		for _, x := range t {
			if hasPlaceholder(x) {
				return true
			}
		}
	case []any:
		for _, x := range t {
			if hasPlaceholder(x) {
				return true
			}
		}
	}
	return false
}

// PlanHelmUpgrade renders the upgrade with a server-side dry run and compares
// it with the deployed manifest. Nothing is changed, so read-only contexts may plan.
func (m *Manager) PlanHelmUpgrade(req HelmUpgradeRequest) (HelmUpgradePlan, error) {
	c, err := m.conn(req.Cluster)
	if err != nil {
		return HelmUpgradePlan{}, err
	}
	cfg, err := helmConfig(c, req.Namespace)
	if err != nil {
		return HelmUpgradePlan{}, err
	}
	rel, err := currentRelease(cfg, req.Name)
	if err != nil {
		return HelmUpgradePlan{}, err
	}
	ch, err := m.loadChart(req, rel.Chart)
	if err != nil {
		return HelmUpgradePlan{}, err
	}
	vals, err := parseUpgradeValues(req.Values, rel.Config)
	if err != nil {
		return HelmUpgradePlan{}, err
	}
	up := action.NewUpgrade(cfg)
	up.Namespace = req.Namespace
	up.DryRunStrategy = action.DryRunServer
	up.WaitStrategy = helmkube.HookOnlyStrategy
	up.HideSecret = false
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	out, err := up.RunWithContext(ctx, req.Name, ch, vals)
	if err != nil {
		return HelmUpgradePlan{}, err
	}
	next, ok := out.(*releasev1.Release)
	if !ok {
		return HelmUpgradePlan{}, fmt.Errorf("unexpected dry-run result")
	}
	plan := HelmUpgradePlan{
		Chart: ch.Metadata.Name, Version: ch.Metadata.Version, AppVersion: ch.Metadata.AppVersion,
		Objects: diffManifests(rel.Manifest, next.Manifest, req.Namespace), Hooks: len(next.Hooks),
		ValueKeys: changedKeys(rel.Config, vals),
	}
	if next.Info != nil {
		plan.Notes = next.Info.Notes
	}
	return plan, nil
}

func changedKeys(before, after map[string]any) []string {
	keys := []string{}
	seen := map[string]bool{}
	for k := range before {
		seen[k] = true
	}
	for k := range after {
		seen[k] = true
	}
	for k := range seen {
		if !reflect.DeepEqual(before[k], after[k]) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

type manifestDoc struct {
	kind, name, namespace, text string
	secret                      map[string]string // data and stringData, for Secrets
}

// secretKind finds a Secret in a document that is not valid YAML.
var secretKind = regexp.MustCompile(`(?m)^\s*kind:\s*["']?Secret["']?\s*(#.*)?$`)

func splitManifest(manifest, defaultNS string) map[string]manifestDoc {
	out := map[string]manifestDoc{}
	for _, part := range strings.Split("\n"+manifest, "\n---") {
		text := strings.TrimSpace(part)
		if text == "" {
			continue
		}
		var meta struct {
			Kind     string `json:"kind"`
			Metadata struct {
				Name      string `json:"name"`
				Namespace string `json:"namespace"`
			} `json:"metadata"`
			// Values are read as any: an unquoted number in a Secret (which
			// Helm keeps in the manifest of a failed release) must not make
			// the document unreadable, and so left as it is.
			Data       map[string]any `json:"data"`
			StringData map[string]any `json:"stringData"`
		}
		if yaml.Unmarshal([]byte(text), &meta) != nil || meta.Kind == "" {
			if secretKind.MatchString(text) {
				// A Secret that cannot be read is never shown as it is.
				out[fmt.Sprintf("Secret/%s/(unreadable %d)", defaultNS, len(out))] = manifestDoc{kind: "Secret", name: "(unreadable)", namespace: defaultNS, secret: map[string]string{}}
			}
			continue
		}
		d := manifestDoc{kind: meta.Kind, name: meta.Metadata.Name, namespace: meta.Metadata.Namespace, text: text}
		if d.namespace == "" {
			d.namespace = defaultNS
		}
		if meta.Kind == "Secret" {
			d.secret = map[string]string{}
			for k, v := range meta.Data {
				d.secret["data."+k] = fmt.Sprint(v)
			}
			for k, v := range meta.StringData {
				d.secret["stringData."+k] = base64.StdEncoding.EncodeToString([]byte(fmt.Sprint(v)))
			}
		}
		out[d.kind+"/"+d.namespace+"/"+d.name] = d
	}
	return out
}

// maskManifestSecret rewrites a Secret's values as "(hidden, N bytes)", marking the
// ones that differ from the other side so a change still shows.
func maskManifestSecret(d manifestDoc, other map[string]string) string {
	var obj map[string]any
	if yaml.Unmarshal([]byte(d.text), &obj) != nil || obj == nil {
		return "# Secret (values hidden: Clustrail could not read this document)"
	}
	for _, field := range []string{"data", "stringData"} {
		m, _ := obj[field].(map[string]any)
		for k := range m {
			raw := d.secret[field+"."+k]
			n := len(raw)
			if b, err := base64.StdEncoding.DecodeString(raw); err == nil {
				n = len(b)
			}
			label := fmt.Sprintf("(hidden, %d bytes)", n)
			if o, ok := other[field+"."+k]; ok && o != raw {
				label = fmt.Sprintf("(hidden, %d bytes, changed)", n)
			}
			m[k] = label
		}
	}
	b, err := yaml.Marshal(obj)
	if err != nil {
		return "# Secret (values hidden)"
	}
	return strings.TrimSpace(string(b))
}

func diffManifests(before, after, ns string) []HelmObjectChange {
	b, a := splitManifest(before, ns), splitManifest(after, ns)
	keys := map[string]bool{}
	for k := range b {
		keys[k] = true
	}
	for k := range a {
		keys[k] = true
	}
	out := make([]HelmObjectChange, 0, len(keys))
	for k := range keys {
		bd, inB := b[k]
		ad, inA := a[k]
		ch := HelmObjectChange{}
		switch {
		case inB && inA:
			ch.Kind, ch.Name, ch.Namespace = ad.kind, ad.name, ad.namespace
			ch.Before, ch.After = bd.text, ad.text
			if ad.secret != nil {
				ch.Before, ch.After = maskManifestSecret(bd, ad.secret), maskManifestSecret(ad, bd.secret)
			}
			ch.Change = "unchanged"
			if bd.text != ad.text {
				ch.Change = "changed"
			}
		case inA:
			ch.Kind, ch.Name, ch.Namespace, ch.Change, ch.After = ad.kind, ad.name, ad.namespace, "added", ad.text
			if ad.secret != nil {
				ch.After = maskManifestSecret(ad, nil)
			}
		default:
			ch.Kind, ch.Name, ch.Namespace, ch.Change, ch.Before = bd.kind, bd.name, bd.namespace, "removed", bd.text
			if bd.secret != nil {
				ch.Before = maskManifestSecret(bd, nil)
			}
		}
		out = append(out, ch)
	}
	order := map[string]int{"changed": 0, "added": 1, "removed": 2, "unchanged": 3}
	sort.Slice(out, func(i, j int) bool {
		if order[out[i].Change] != order[out[j].Change] {
			return order[out[i].Change] < order[out[j].Change]
		}
		return out[i].Kind+"/"+out[i].Name < out[j].Kind+"/"+out[j].Name
	})
	return out
}

// UpgradeRelease runs `helm upgrade` with the bundled Helm SDK. Progress is reported as a Job.
func (m *Manager) UpgradeRelease(req HelmUpgradeRequest) (string, error) {
	c, err := m.writable(req.Cluster)
	if err != nil {
		return "", err
	}
	cfg, err := helmConfig(c, req.Namespace)
	if err != nil {
		return "", err
	}
	rel, err := currentRelease(cfg, req.Name)
	if err != nil {
		return "", err
	}
	ch, err := m.loadChart(req, rel.Chart)
	if err != nil {
		return "", err
	}
	vals, err := parseUpgradeValues(req.Values, rel.Config)
	if err != nil {
		return "", err
	}
	up := action.NewUpgrade(cfg)
	up.Namespace = req.Namespace
	up.Timeout = time.Duration(max(req.TimeoutSec, 30)) * time.Second
	up.RollbackOnFailure = req.Atomic
	up.WaitStrategy = helmkube.HookOnlyStrategy
	if req.Wait || req.Atomic {
		up.WaitStrategy = helmkube.StatusWatcherStrategy
	}
	up.Description = fmt.Sprintf("Upgrade to %s %s (Clustrail)", ch.Metadata.Name, ch.Metadata.Version)

	jobID := fmt.Sprintf("helm-up-%s-%s-%s-%d", req.Cluster, req.Namespace, req.Name, time.Now().UnixMilli())
	report := func(j Job) { j.ID, j.Title = jobID, "Upgrading "+req.Name; m.emit.Emit(EventJob, j) }
	detail := fmt.Sprintf("%s %s", ch.Metadata.Name, ch.Metadata.Version)
	if up.WaitStrategy == helmkube.StatusWatcherStrategy {
		detail += " · waiting for resources"
	}
	report(Job{Progress: 0.2, Detail: detail})
	safeGo("Helm upgrade", func(err error) { report(Job{Done: true, Error: err.Error()}) }, func() {
		ctx, cancel := context.WithTimeout(context.Background(), up.Timeout+time.Minute)
		defer cancel()
		out, err := up.RunWithContext(ctx, req.Name, ch, vals)
		if err != nil {
			report(Job{Done: true, Error: err.Error()})
			return
		}
		rev := 0
		if r, ok := out.(*releasev1.Release); ok {
			rev = r.Version
		}
		report(Job{Done: true, Progress: 1, Detail: fmt.Sprintf("revision %d deployed", rev)})
	})
	return jobID, nil
}

// helmRepoEntry is a repositories.yaml entry with its credentials; it stays in
// the backend (HelmRepository, which the UI gets, has name and URL only).
type helmRepoEntry struct {
	Name                  string `json:"name"`
	URL                   string `json:"url"`
	Username              string `json:"username"`
	Password              string `json:"password"`
	CAFile                string `json:"caFile"`
	CertFile              string `json:"certFile"`
	KeyFile               string `json:"keyFile"`
	InsecureSkipTLSVerify bool   `json:"insecure_skip_tls_verify"`
	PassCredentialsAll    bool   `json:"pass_credentials_all"`
}

func helmRepoEntries() ([]helmRepoEntry, error) {
	raw, err := os.ReadFile(helmRepositoryConfig())
	if err != nil {
		return nil, err
	}
	var f struct {
		Repositories []helmRepoEntry `json:"repositories"`
	}
	if err := yaml.Unmarshal(raw, &f); err != nil {
		return nil, err
	}
	return f.Repositories, nil
}

func containsLine(text, line string) bool {
	for _, l := range strings.Split(text, "\n") {
		if strings.TrimSpace(l) == line {
			return true
		}
	}
	return false
}

// maskSecretsInManifest hides the values of every Secret in a rendered
// manifest (Helm revision views); other documents are kept as they are.
func maskSecretsInManifest(manifest string) string {
	// Helm's manifest starts with "---": a leading newline makes the first
	// document split like the others, so its "# Source:" comment is kept too.
	parts := strings.Split("\n"+manifest, "\n---")
	for i, part := range parts {
		docs := splitManifest(part, "")
		for _, d := range docs {
			if d.secret == nil {
				continue
			}
			// Keep Helm's "# Source:" comment, which the re-encoded YAML would lose.
			var head []string
			for _, line := range strings.Split(strings.TrimLeft(part, "\n"), "\n") {
				if !strings.HasPrefix(line, "#") {
					break
				}
				head = append(head, line)
			}
			masked := maskManifestSecret(d, nil)
			if len(head) > 0 {
				masked = strings.Join(head, "\n") + "\n" + masked
			}
			parts[i] = "\n" + masked + "\n"
		}
	}
	return strings.TrimPrefix(strings.Join(parts, "\n---"), "\n")
}
