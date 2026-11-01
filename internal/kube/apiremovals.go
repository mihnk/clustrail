package kube

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/version"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/metadata"
	"sigs.k8s.io/yaml"
)

// API removals (feature "upgrade readiness"): which objects use an API
// version that a Kubernetes release no longer serves.
//
// Only sources that record the version that was used count:
//   - the manifest Helm stored for a release,
//   - kubectl's last-applied-configuration annotation,
//   - the API server's apiserver_requested_deprecated_apis metric.
//
// A live object cannot tell: the API server converts every object to the
// version it is asked for, so reading an Ingress as networking.k8s.io/v1
// says nothing about the version it was created with.

// APIRemoval is one API version a Kubernetes release stops serving.
type APIRemoval struct {
	Group   string `json:"group"`
	Version string `json:"version"`
	Kind    string `json:"kind"`
	// Deprecated and Removed are Kubernetes minor versions ("1.25").
	Deprecated string `json:"deprecated"`
	Removed    string `json:"removed"`
	// Replacement is the group/version to use instead ("batch/v1"), empty when
	// the API was dropped without one.
	Replacement string `json:"replacement,omitempty"`
}

func (r APIRemoval) groupVersion() string {
	return schema.GroupVersion{Group: r.Group, Version: r.Version}.String()
}

// APIRemovalFinding is one place that records a removed API version.
type APIRemovalFinding struct {
	// Source: "helm" (a release's stored manifest), "applied" (kubectl's
	// last-applied annotation) or "apiserver" (the API server counted a request).
	Source     string `json:"source"`
	APIVersion string `json:"apiVersion"` // group/version as used
	Kind       string `json:"kind,omitempty"`
	// Resource is set for "apiserver": the metric names the resource, not the kind.
	Resource    string `json:"resource,omitempty"`
	Removed     string `json:"removed"` // "" when no release is set for it
	Deprecated  string `json:"deprecated,omitempty"`
	Replacement string `json:"replacement,omitempty"`
	Namespace   string `json:"namespace,omitempty"`
	Name        string `json:"name,omitempty"`
	// Release and Revision: for "helm", the release that stored it.
	Release  string `json:"release,omitempty"`
	Revision int    `json:"revision,omitempty"`
	Hook     bool   `json:"hook,omitempty"`
}

type APIRemovalReport struct {
	Cluster string `json:"cluster"`
	// Server is the API server's version, "1.30"; Minor is 30 (0 when unknown).
	Server   string              `json:"server"`
	Minor    int                 `json:"minor"`
	Findings []APIRemovalFinding `json:"findings"`
	// Notes are sources that could not be read, and what was left out.
	Notes []string `json:"notes"`
	// APIServerStarted: when the API server that answered /metrics started (RFC 3339), "" if unknown.
	APIServerStarted string `json:"apiServerStarted,omitempty"`
	// Scanned counts what was read: Helm releases, objects checked for last-applied.
	Releases int `json:"releases"`
	Objects  int `json:"objects"`
}

type lifecycleRemoved interface{ APILifecycleRemoved() (int, int) }
type lifecycleDeprecated interface{ APILifecycleDeprecated() (int, int) }
type lifecycleReplacement interface {
	APILifecycleReplacement() schema.GroupVersionKind
}

// removedFromAPIModule are removals whose types k8s.io/api no longer has, so
// they carry no lifecycle tags any more. From the Kubernetes deprecated API
// migration guide.
var removedFromAPIModule = []APIRemoval{
	{Group: "autoscaling", Version: "v2beta1", Kind: "HorizontalPodAutoscaler", Deprecated: "1.22", Removed: "1.25", Replacement: "autoscaling/v2"},
	{Group: "autoscaling", Version: "v2beta2", Kind: "HorizontalPodAutoscaler", Deprecated: "1.23", Removed: "1.26", Replacement: "autoscaling/v2"},
	{Group: "policy", Version: "v1beta1", Kind: "PodSecurityPolicy", Deprecated: "1.21", Removed: "1.25"},
	{Group: "extensions", Version: "v1beta1", Kind: "PodSecurityPolicy", Deprecated: "1.11", Removed: "1.16", Replacement: "policy/v1beta1"},
	{Group: "apiregistration.k8s.io", Version: "v1beta1", Kind: "APIService", Deprecated: "1.19", Removed: "1.22", Replacement: "apiregistration.k8s.io/v1"},
}

var removals struct {
	once   sync.Once
	byGVK  map[schema.GroupVersionKind]APIRemoval
	byGVR  map[schema.GroupVersionResource]APIRemoval
	sorted []APIRemoval
}

// KnownAPIRemovals is every known removal: the lifecycle tags Kubernetes keeps in
// k8s.io/api (so the list follows the client-go version), plus the few
// already deleted from it.
func KnownAPIRemovals() []APIRemoval {
	loadRemovals()
	return removals.sorted
}

func loadRemovals() {
	removals.once.Do(func() {
		byGVK := map[schema.GroupVersionKind]APIRemoval{}
		for gvk := range scheme.Scheme.AllKnownTypes() {
			if strings.HasSuffix(gvk.Kind, "List") || gvk.Version == "__internal" {
				continue
			}
			obj, err := scheme.Scheme.New(gvk)
			if err != nil {
				continue
			}
			rm, ok := obj.(lifecycleRemoved)
			if !ok {
				continue
			}
			r := APIRemoval{Group: gvk.Group, Version: gvk.Version, Kind: gvk.Kind, Removed: release(rm.APILifecycleRemoved())}
			if d, ok := obj.(lifecycleDeprecated); ok {
				r.Deprecated = release(d.APILifecycleDeprecated())
			}
			if rp, ok := obj.(lifecycleReplacement); ok {
				if g := rp.APILifecycleReplacement(); g.Version != "" {
					r.Replacement = g.GroupVersion().String()
				}
			}
			byGVK[gvk] = r
		}
		for _, r := range removedFromAPIModule {
			gvk := schema.GroupVersionKind{Group: r.Group, Version: r.Version, Kind: r.Kind}
			if _, ok := byGVK[gvk]; !ok {
				byGVK[gvk] = r
			}
		}
		removals.byGVK = byGVK
		removals.byGVR = map[schema.GroupVersionResource]APIRemoval{}
		for gvk, r := range byGVK {
			plural, _ := meta.UnsafeGuessKindToResource(gvk)
			removals.byGVR[plural] = r
			removals.sorted = append(removals.sorted, r)
		}
		sort.Slice(removals.sorted, func(i, j int) bool {
			a, b := removals.sorted[i], removals.sorted[j]
			if c := compareRelease(a.Removed, b.Removed); c != 0 {
				return c < 0
			}
			if a.Group != b.Group {
				return a.Group < b.Group
			}
			if a.Version != b.Version {
				return a.Version < b.Version
			}
			return a.Kind < b.Kind
		})
	})
}

func release(major, minor int) string {
	if major == 0 && minor == 0 {
		return ""
	}
	return fmt.Sprintf("%d.%d", major, minor)
}

// compareRelease orders "1.9" before "1.25"; "" (no release) last.
func compareRelease(a, b string) int {
	if a == b {
		return 0
	}
	if a == "" {
		return 1
	}
	if b == "" {
		return -1
	}
	am, an := splitRelease(a)
	bm, bn := splitRelease(b)
	if am != bm {
		return am - bm
	}
	return an - bn
}

func splitRelease(s string) (int, int) {
	maj, min, _ := strings.Cut(s, ".")
	a, _ := strconv.Atoi(maj)
	b, _ := strconv.Atoi(min)
	return a, b
}

// removalFor is the removal for an apiVersion and kind, if any.
func removalFor(apiVersion, kind string) (APIRemoval, bool) {
	loadRemovals()
	gv, err := schema.ParseGroupVersion(apiVersion)
	if err != nil {
		return APIRemoval{}, false
	}
	r, ok := removals.byGVK[gv.WithKind(kind)]
	return r, ok
}

// Kinds that controllers create rather than people: they never carry a
// last-applied annotation, and some (Events, Leases, EndpointSlices) are
// numerous, so they are not listed. Requests for them still show in the
// API server's count.
var notApplied = map[string]bool{
	"Event": true, "Lease": true, "LeaseCandidate": true, "EndpointSlice": true, "ControllerRevision": true,
	"CSINode": true, "VolumeAttachment": true, "CSIStorageCapacity": true, "CertificateSigningRequest": true,
	"ResourceSlice": true, "ResourceClaim": true, "IPAddress": true, "PodCertificateRequest": true,
	"StorageVersionMigration": true, "EvictionRequest": true,
}

// removalDiscovery is the part of discovery a scan uses.
type removalDiscovery interface {
	ServerVersion() (*version.Info, error)
	ServerPreferredResources() ([]*metav1.APIResourceList, error)
}

// removalSources is what a scan reads; tests give fakes.
type removalSources struct {
	cluster    string
	discovery  removalDiscovery
	meta       metadata.Interface
	metrics    func(ctx context.Context) (io.ReadCloser, error)
	releases   func(ctx context.Context) ([]*storedRelease, int, error)
	fallbackNS string
}

// APIRemovals reports what records a removed API version on a cluster.
func (m *Manager) APIRemovals(cluster string) (APIRemovalReport, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return APIRemovalReport{}, err
	}
	src := removalSources{cluster: cluster, discovery: c.client.Discovery(), fallbackNS: c.fallbackNS, releases: c.storedReleases}
	if c.rest != nil {
		if mc, err := metadata.NewForConfig(c.rest); err == nil {
			src.meta = mc
		}
	}
	if rc := c.client.CoreV1().RESTClient(); rc != nil && c.rest != nil {
		src.metrics = func(ctx context.Context) (io.ReadCloser, error) { return rc.Get().AbsPath("/metrics").Stream(ctx) }
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	return scanRemovals(ctx, src), nil
}

func scanRemovals(ctx context.Context, s removalSources) APIRemovalReport {
	out := APIRemovalReport{Cluster: s.cluster, Findings: []APIRemovalFinding{}, Notes: []string{}}
	if v, err := s.discovery.ServerVersion(); err == nil {
		out.Minor = leadingInt(v.Minor)
		if out.Minor > 0 {
			out.Server = fmt.Sprintf("%s.%d", strings.TrimRight(v.Major, "+"), out.Minor)
		}
	} else {
		out.Notes = append(out.Notes, "Server version: "+err.Error())
	}

	if s.releases != nil {
		rels, n, err := s.releases(ctx)
		if err != nil {
			out.Notes = append(out.Notes, "Helm releases: "+errorReason(err))
		}
		out.Releases = n
		out.Findings = append(out.Findings, helmRemovals(rels)...)
	}

	if s.meta != nil {
		found, n, notes := appliedRemovals(ctx, s)
		out.Findings = append(out.Findings, found...)
		out.Objects = n
		out.Notes = append(out.Notes, notes...)
	} else {
		out.Notes = append(out.Notes, "last-applied annotations: not read")
	}

	if s.metrics != nil {
		found, started, err := metricRemovals(ctx, s.metrics)
		switch {
		case apierrors.IsForbidden(err):
			out.Notes = append(out.Notes, "API server metrics: not allowed (needs get on the /metrics URL)")
		case err != nil:
			out.Notes = append(out.Notes, "API server metrics: "+err.Error())
		}
		out.Findings = append(out.Findings, found...)
		if !started.IsZero() {
			out.APIServerStarted = started.UTC().Format(time.RFC3339)
		}
	}

	sort.SliceStable(out.Findings, func(i, j int) bool {
		a, b := out.Findings[i], out.Findings[j]
		if c := compareRelease(a.Removed, b.Removed); c != 0 {
			return c < 0
		}
		if a.APIVersion+a.Kind != b.APIVersion+b.Kind {
			return a.APIVersion+a.Kind < b.APIVersion+b.Kind
		}
		return a.Source+a.Namespace+a.Name < b.Source+b.Namespace+b.Name
	})
	return out
}

func leadingInt(s string) int {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	n, _ := strconv.Atoi(s[:i])
	return n
}

// storedReleases is the current revision of every Helm release: from the Helm
// watcher's cache when it has one, else listed now.
func (c *clusterConn) storedReleases(ctx context.Context) ([]*storedRelease, int, error) {
	var secrets []*corev1.Secret
	if h := c.helm; h != nil && h.lister != nil && h.synced() {
		secrets, _ = h.lister.List(labels.Everything())
	} else {
		ns := ""
		list, err := c.client.CoreV1().Secrets(ns).List(ctx, metav1.ListOptions{LabelSelector: "owner=helm", FieldSelector: "type=helm.sh/release.v1"})
		if apierrors.IsForbidden(err) && c.fallbackNS != "" {
			list, err = c.client.CoreV1().Secrets(c.fallbackNS).List(ctx, metav1.ListOptions{LabelSelector: "owner=helm", FieldSelector: "type=helm.sh/release.v1"})
		}
		if err != nil {
			return nil, 0, err
		}
		for i := range list.Items {
			secrets = append(secrets, &list.Items[i])
		}
	}
	rels := currentReleases(secrets)
	return rels, len(rels), nil
}

// currentReleases picks, per release, the revision Helm upgrades from: the
// newest deployed one, else the newest.
func currentReleases(secrets []*corev1.Secret) []*storedRelease {
	type key struct{ ns, name string }
	cur := map[key]*storedRelease{}
	for _, s := range secrets {
		if s.Type != "helm.sh/release.v1" {
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
		if prev := cur[k]; prev == nil || newerCurrent(r, prev) {
			cur[k] = r
		}
	}
	out := make([]*storedRelease, 0, len(cur))
	for _, r := range cur {
		out = append(out, r)
	}
	return out
}

// newerCurrent: a deployed revision wins over one that is not, then the higher revision.
func newerCurrent(r, prev *storedRelease) bool {
	rd, pd := r.Info.Status == "deployed", prev.Info.Status == "deployed"
	if rd != pd {
		return rd
	}
	return r.Version > prev.Version
}

func helmRemovals(rels []*storedRelease) []APIRemovalFinding {
	var out []APIRemovalFinding
	for _, r := range rels {
		docs := []struct {
			text string
			hook bool
		}{{r.Manifest, false}}
		for _, h := range r.Hooks {
			docs = append(docs, struct {
				text string
				hook bool
			}{h.Manifest, true})
		}
		for _, d := range docs {
			for _, obj := range manifestObjects(d.text) {
				rm, ok := removalFor(obj.APIVersion, obj.Kind)
				if !ok {
					continue
				}
				ns := obj.Metadata.Namespace
				if ns == "" {
					ns = r.Namespace
				}
				out = append(out, finding("helm", obj.APIVersion, obj.Kind, rm, ns, obj.Metadata.Name, func(f *APIRemovalFinding) {
					f.Release, f.Revision, f.Hook = r.Name, r.Version, d.hook
				}))
			}
		}
	}
	return out
}

type manifestObject struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Metadata   struct {
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
	} `json:"metadata"`
}

var docSeparator = regexp.MustCompile(`(?m)^---[ \t]*$`)

func manifestObjects(manifest string) []manifestObject {
	var out []manifestObject
	for _, doc := range docSeparator.Split(manifest, -1) {
		var o manifestObject
		if yaml.Unmarshal([]byte(doc), &o) == nil && o.Kind != "" && o.APIVersion != "" {
			out = append(out, o)
		}
	}
	return out
}

func finding(source, apiVersion, kind string, rm APIRemoval, ns, name string, more func(*APIRemovalFinding)) APIRemovalFinding {
	f := APIRemovalFinding{Source: source, APIVersion: apiVersion, Kind: kind, Removed: rm.Removed, Deprecated: rm.Deprecated, Replacement: rm.Replacement, Namespace: ns, Name: name}
	if more != nil {
		more(&f)
	}
	return f
}

// appliedRemovals lists, for every kind that has a removed version, the
// objects' metadata and reads the apiVersion kubectl last applied.
func appliedRemovals(ctx context.Context, s removalSources) ([]APIRemovalFinding, int, []string) {
	loadRemovals()
	kinds := map[schema.GroupKind]bool{}
	for gvk := range removals.byGVK {
		if !notApplied[gvk.Kind] {
			kinds[gvk.GroupKind()] = true
		}
	}
	lists, err := s.discovery.ServerPreferredResources()
	if err != nil && len(lists) == 0 {
		return nil, 0, []string{"last-applied annotations: " + err.Error()}
	}
	type target struct {
		gvr        schema.GroupVersionResource
		kind       string
		namespaced bool
	}
	var targets []target
	for _, l := range lists {
		gv, err := schema.ParseGroupVersion(l.GroupVersion)
		if err != nil {
			continue
		}
		for _, r := range l.APIResources {
			if strings.Contains(r.Name, "/") || !kinds[schema.GroupKind{Group: gv.Group, Kind: r.Kind}] || !hasVerb(r.Verbs, "list") {
				continue
			}
			targets = append(targets, target{gv.WithResource(r.Name), r.Kind, r.Namespaced})
		}
	}
	sort.Slice(targets, func(i, j int) bool { return targets[i].gvr.String() < targets[j].gvr.String() })

	var out []APIRemovalFinding
	var notes []string
	objects := 0
	for _, t := range targets {
		n, found, err := listApplied(ctx, s.meta, t.gvr, "")
		if apierrors.IsForbidden(err) && t.namespaced && s.fallbackNS != "" {
			n, found, err = listApplied(ctx, s.meta, t.gvr, s.fallbackNS)
			if err == nil {
				notes = append(notes, fmt.Sprintf("%s: only namespace %s (not allowed to list them cluster-wide)", t.kind, s.fallbackNS))
			}
		}
		if err != nil {
			notes = append(notes, fmt.Sprintf("%s: %s", t.kind, errorReason(err)))
			continue
		}
		objects += n
		out = append(out, found...)
	}
	return out, objects, notes
}

func listApplied(ctx context.Context, mc metadata.Interface, gvr schema.GroupVersionResource, ns string) (int, []APIRemovalFinding, error) {
	var out []APIRemovalFinding
	n := 0
	opts := metav1.ListOptions{Limit: 500}
	for {
		list, err := mc.Resource(gvr).Namespace(ns).List(ctx, opts)
		if err != nil {
			return n, out, err
		}
		for _, item := range list.Items {
			n++
			raw := item.Annotations[lastApplied]
			if raw == "" {
				continue
			}
			var applied struct {
				APIVersion string `json:"apiVersion"`
				Kind       string `json:"kind"`
			}
			if json.Unmarshal([]byte(raw), &applied) != nil {
				continue
			}
			if rm, ok := removalFor(applied.APIVersion, applied.Kind); ok {
				out = append(out, finding("applied", applied.APIVersion, applied.Kind, rm, item.Namespace, item.Name, nil))
			}
		}
		if list.Continue == "" {
			return n, out, nil
		}
		opts.Continue = list.Continue
	}
}

// maxMetricsBytes bounds how much of /metrics is read (a large API server
// serves a few MB).
const maxMetricsBytes = 64 << 20

var metricLabel = regexp.MustCompile(`([a-z_]+)="((?:[^"\\]|\\.)*)"`)

// metricRemovals reads apiserver_requested_deprecated_apis: the API server
// sets it to 1 for every deprecated group/version/resource a client asked for
// since it started.
func metricRemovals(ctx context.Context, open func(context.Context) (io.ReadCloser, error)) ([]APIRemovalFinding, time.Time, error) {
	body, err := open(ctx)
	if err != nil {
		return nil, time.Time{}, err
	}
	defer body.Close()
	return parseDeprecatedMetric(io.LimitReader(body, maxMetricsBytes))
}

func parseDeprecatedMetric(r io.Reader) ([]APIRemovalFinding, time.Time, error) {
	loadRemovals()
	var out []APIRemovalFinding
	var started time.Time
	seen := map[string]bool{}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if v, ok := strings.CutPrefix(line, "process_start_time_seconds "); ok {
			if f, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil && f > 0 {
				started = time.Unix(int64(f), 0)
			}
			continue
		}
		rest, ok := strings.CutPrefix(line, "apiserver_requested_deprecated_apis{")
		if !ok {
			continue
		}
		end := strings.LastIndexByte(rest, '}')
		if end < 0 {
			continue
		}
		if val := strings.TrimSpace(rest[end+1:]); val == "0" {
			continue
		}
		l := map[string]string{}
		for _, m := range metricLabel.FindAllStringSubmatch(rest[:end], -1) {
			l[m[1]] = m[2]
		}
		if l["subresource"] != "" {
			continue // the resource itself is listed too
		}
		gv := schema.GroupVersion{Group: l["group"], Version: l["version"]}
		key := gv.String() + "/" + l["resource"]
		if l["version"] == "" || l["resource"] == "" || seen[key] {
			continue
		}
		seen[key] = true
		f := APIRemovalFinding{Source: "apiserver", APIVersion: gv.String(), Resource: l["resource"], Removed: l["removed_release"]}
		if rm, ok := removals.byGVR[gv.WithResource(l["resource"])]; ok {
			f.Kind, f.Deprecated, f.Replacement = rm.Kind, rm.Deprecated, rm.Replacement
		}
		out = append(out, f)
	}
	return out, started, sc.Err()
}
