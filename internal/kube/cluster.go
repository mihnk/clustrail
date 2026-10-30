package kube

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	authnv1 "k8s.io/api/authentication/v1"
	authzv1 "k8s.io/api/authorization/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	listersappsv1 "k8s.io/client-go/listers/apps/v1"
	listersautoscalingv2 "k8s.io/client-go/listers/autoscaling/v2"
	listerscorev1 "k8s.io/client-go/listers/core/v1"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/cache"
	metricsclient "k8s.io/metrics/pkg/client/clientset/versioned"
)

// Emitter sends events to the frontend (the Wails event bus in the app).
type Emitter interface {
	Emit(name string, data any)
}

const (
	EventDelta    = "clustrail:delta"
	EventClusters = "clustrail:clusters"
	EventJob      = "clustrail:job"

	flushInterval   = 250 * time.Millisecond
	probeInterval   = 15 * time.Second
	metricsInterval = 15 * time.Second
)

// clusterConn is one connected context: clients, informers and the rows
// derived from them. Rows are rebuilt for changed objects only and sent to
// the frontend as deltas at most every flushInterval.
type clusterConn struct {
	id   string
	env  func() Environment
	emit Emitter

	rest    *rest.Config
	client  kubernetes.Interface
	dynamic dynamic.Interface
	metrics metricsclient.Interface

	cancel context.CancelFunc
	ctx    context.Context

	factory   informers.SharedInformerFactory
	pods      listerscorev1.PodLister
	nodes     listerscorev1.NodeLister
	deploys   listersappsv1.DeploymentLister
	rsets     listersappsv1.ReplicaSetLister
	hpas      listersautoscalingv2.HorizontalPodAutoscalerLister
	helm      *helmWatcher
	gitops    *gitopsWatcher
	forbidden []Forbidden
	syncFns   []cache.InformerSynced
	kinds     kindIndex

	mu         sync.Mutex
	dirtyPods  map[string]bool // ns/name
	dirtyDeps  map[string]bool
	nodesDirty bool
	resetSent  map[string]bool
	podUsage   map[string]Usage // ns/name
	nodeUsage  map[string]Usage
	samples    *sampleStore
	onState    func(ConnectionState, error)
}

// Forbidden is a resource this identity cannot list cluster-wide.
type Forbidden struct {
	Cluster   string `json:"cluster"`
	Namespace string `json:"namespace"`
	User      string `json:"user"`
	Resource  string `json:"resource"`
}

// ConnectInfo is what a successful connect learned about the cluster.
type ConnectInfo struct {
	LatencyMs int
	Version   string
	Summary   string
	Identity  string
	Metrics   bool
}

// classifyError maps a client error to the connection state the UI shows.
func classifyError(err error) ConnectionState {
	if err == nil {
		return Connected
	}
	msg := err.Error()
	var netErr net.Error
	var urlErr *url.Error
	switch {
	case apierrors.IsUnauthorized(err),
		strings.Contains(msg, "exec plugin"),
		strings.Contains(msg, "getting credentials"),
		strings.Contains(msg, "token expired"),
		strings.Contains(msg, "Reauthentication"),
		strings.Contains(msg, "refresh token"):
		return AuthExpired
	case errors.As(err, &netErr), errors.As(err, &urlErr),
		strings.Contains(msg, "connection refused"),
		strings.Contains(msg, "no such host"),
		strings.Contains(msg, "i/o timeout"),
		strings.Contains(msg, "certificate"):
		return Unreachable
	}
	return Unreachable
}

func newClusterConn(id string, cfg *rest.Config, env func() Environment, emit Emitter, onState func(ConnectionState, error)) (*clusterConn, error) {
	cfg = rest.CopyConfig(cfg)
	cfg.QPS, cfg.Burst = 50, 100
	cfg.UserAgent = "clustrail"
	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	mc, err := metricsclient.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	c := connFromClients(id, env, emit, onState, client, dyn, mc)
	c.rest = cfg
	return c, nil
}

// connFromClients builds a connection around existing clients (tests use fakes).
func connFromClients(id string, env func() Environment, emit Emitter, onState func(ConnectionState, error), client kubernetes.Interface, dyn dynamic.Interface, mc metricsclient.Interface) *clusterConn {
	return &clusterConn{
		id: id, env: env, emit: emit, client: client, dynamic: dyn, metrics: mc,
		dirtyPods: map[string]bool{}, dirtyDeps: map[string]bool{}, resetSent: map[string]bool{},
		podUsage: map[string]Usage{}, nodeUsage: map[string]Usage{}, samples: newSampleStore(120),
		onState: onState,
	}
}

// probe checks reachability and credentials and learns version, identity and metrics support.
func (c *clusterConn) probe(ctx context.Context) (ConnectInfo, error) {
	var info ConnectInfo
	start := time.Now()
	v, err := c.client.Discovery().ServerVersion()
	if err != nil {
		return info, err
	}
	info.LatencyMs = int(time.Since(start).Milliseconds())
	info.Version = v.GitVersion
	info.Summary = providerOf(v.GitVersion) + " " + shortVersion(v.GitVersion)

	// Who RBAC sees (authentication.k8s.io/v1 SelfSubjectReview, GA since 1.28).
	if r, err := c.client.AuthenticationV1().SelfSubjectReviews().Create(ctx, &authnv1.SelfSubjectReview{}, metav1.CreateOptions{}); err == nil {
		info.Identity = shortIdentity(r.Status.UserInfo.Username)
	}
	if groups, err := c.client.Discovery().ServerGroups(); err == nil {
		for _, g := range groups.Groups {
			if g.Name == "metrics.k8s.io" {
				info.Metrics = true
			}
		}
	}
	return info, nil
}

func providerOf(gitVersion string) string {
	switch {
	case strings.Contains(gitVersion, "-eks-"):
		return "EKS"
	case strings.Contains(gitVersion, "-gke."):
		return "GKE"
	case strings.Contains(gitVersion, "+k3s"):
		return "k3s"
	case strings.Contains(gitVersion, "+rke2"):
		return "RKE2"
	case strings.Contains(gitVersion, "-aks") || strings.Contains(gitVersion, "azure"):
		return "AKS"
	}
	return "Kubernetes"
}

// shortIdentity turns "arn:aws:sts::1234:assumed-role/sre-oncall/jane" into "sre-oncall".
func shortIdentity(u string) string {
	if strings.HasPrefix(u, "arn:aws:sts::") {
		parts := strings.Split(u, "/")
		if len(parts) >= 2 {
			return parts[1]
		}
	}
	if strings.HasPrefix(u, "system:serviceaccount:") {
		return "sa:" + strings.TrimPrefix(u, "system:serviceaccount:")
	}
	return u
}

// canList asks the API server whether this identity may list a resource cluster-wide.
func (c *clusterConn) canList(ctx context.Context, group, resource string) bool {
	r, err := c.client.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, &authzv1.SelfSubjectAccessReview{
		Spec: authzv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authzv1.ResourceAttributes{Verb: "list", Group: group, Resource: resource}},
	}, metav1.CreateOptions{})
	return err != nil || r.Status.Allowed // on error, try and let the informer report
}

// start launches informers and the flush, probe and metrics loops.
func (c *clusterConn) start(parent context.Context, identity string, withMetrics bool) error {
	c.ctx, c.cancel = context.WithCancel(parent)
	ctx := c.ctx
	c.factory = informers.NewSharedInformerFactory(c.client, 0)

	watchErr := func(_ *cache.Reflector, err error) {
		if errors.Is(err, context.Canceled) || ctx.Err() != nil {
			return
		}
		c.onState(Reconnecting, err)
	}
	add := func(inf cache.SharedIndexInformer, onChange func(obj any)) {
		c.syncFns = append(c.syncFns, inf.HasSynced)
		_ = inf.SetWatchErrorHandler(watchErr)
		_, _ = inf.AddEventHandler(cache.ResourceEventHandlerFuncs{
			AddFunc:    onChange,
			UpdateFunc: func(_, obj any) { onChange(obj) },
			DeleteFunc: func(obj any) {
				if d, ok := obj.(cache.DeletedFinalStateUnknown); ok {
					obj = d.Obj
				}
				onChange(obj)
			},
		})
	}

	type res struct{ group, resource string }
	allowed := map[res]bool{}
	for _, r := range []res{{"", "pods"}, {"", "nodes"}, {"apps", "deployments"}, {"apps", "replicasets"}, {"autoscaling", "horizontalpodautoscalers"}} {
		allowed[r] = c.canList(ctx, r.group, r.resource)
		if !allowed[r] {
			c.forbidden = append(c.forbidden, Forbidden{Cluster: c.id, Namespace: "all namespaces", User: identity, Resource: r.resource})
		}
	}

	if allowed[res{"", "pods"}] {
		inf := c.factory.Core().V1().Pods()
		c.pods = inf.Lister()
		add(inf.Informer(), func(obj any) {
			if p, ok := obj.(*corev1.Pod); ok {
				c.mu.Lock()
				c.dirtyPods[p.Namespace+"/"+p.Name] = true
				c.nodesDirty = true
				if o := metav1.GetControllerOf(p); o != nil && o.Kind == "ReplicaSet" {
					if dep := c.deploymentOfRS(p.Namespace, o.Name); dep != "" {
						c.dirtyDeps[p.Namespace+"/"+dep] = true
					}
				}
				c.mu.Unlock()
			}
		})
	}
	if allowed[res{"", "nodes"}] {
		inf := c.factory.Core().V1().Nodes()
		c.nodes = inf.Lister()
		add(inf.Informer(), func(any) {
			c.mu.Lock()
			c.nodesDirty = true
			c.mu.Unlock()
		})
	}
	if allowed[res{"apps", "deployments"}] {
		inf := c.factory.Apps().V1().Deployments()
		c.deploys = inf.Lister()
		add(inf.Informer(), func(obj any) {
			if d, ok := obj.(*appsv1.Deployment); ok {
				c.mu.Lock()
				c.dirtyDeps[d.Namespace+"/"+d.Name] = true
				c.mu.Unlock()
			}
		})
	}
	if allowed[res{"apps", "replicasets"}] {
		inf := c.factory.Apps().V1().ReplicaSets()
		c.rsets = inf.Lister()
		add(inf.Informer(), func(obj any) {
			if rs, ok := obj.(*appsv1.ReplicaSet); ok {
				if o := metav1.GetControllerOf(rs); o != nil && o.Kind == "Deployment" {
					c.mu.Lock()
					c.dirtyDeps[rs.Namespace+"/"+o.Name] = true
					c.mu.Unlock()
				}
			}
		})
	}
	if allowed[res{"autoscaling", "horizontalpodautoscalers"}] {
		inf := c.factory.Autoscaling().V2().HorizontalPodAutoscalers()
		c.hpas = inf.Lister()
		add(inf.Informer(), func(obj any) {
			if h, ok := obj.(*autoscalingv2.HorizontalPodAutoscaler); ok && h.Spec.ScaleTargetRef.Kind == "Deployment" {
				c.mu.Lock()
				c.dirtyDeps[h.Namespace+"/"+h.Spec.ScaleTargetRef.Name] = true
				c.mu.Unlock()
			}
		})
	}

	c.helm = newHelmWatcher(c)
	c.gitops = newGitOpsWatcher(c)

	c.factory.Start(ctx.Done())
	c.helm.start(ctx)
	c.gitops.start(ctx)

	go c.flushLoop(ctx)
	if withMetrics {
		go c.metricsLoop(ctx)
	}
	return nil
}

func (c *clusterConn) stop() {
	if c.cancel != nil {
		c.cancel()
	}
	if c.factory != nil {
		c.factory.Shutdown()
	}
}

func (c *clusterConn) synced() bool {
	for _, f := range c.syncFns {
		if !f() {
			return false
		}
	}
	return true
}

// deploymentOfRS returns the Deployment owning a ReplicaSet, or "".
func (c *clusterConn) deploymentOfRS(ns, rs string) string {
	if c.rsets == nil {
		return ""
	}
	obj, err := c.rsets.ReplicaSets(ns).Get(rs)
	if err != nil {
		return ""
	}
	if o := metav1.GetControllerOf(obj); o != nil && o.Kind == "Deployment" {
		return o.Name
	}
	return ""
}

func (c *clusterConn) ownerOf(ns, name string) *OwnerRef {
	if strings.HasPrefix(name, "job/") {
		// Jobs created by CronJobs show the CronJob.
		return nil
	}
	if d := c.deploymentOfRS(ns, name); d != "" {
		return &OwnerRef{Kind: "Deployment", Name: d}
	}
	return nil
}

func (c *clusterConn) flushLoop(ctx context.Context) {
	t := time.NewTicker(flushInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.flush()
		}
	}
}

// flush sends everything that changed since the last flush. The first flush
// after the caches sync sends the full list as a reset.
func (c *clusterConn) flush() {
	if !c.synced() {
		return
	}
	now := time.Now()
	env := c.env()

	c.mu.Lock()
	pods, deps, nodes := c.dirtyPods, c.dirtyDeps, c.nodesDirty
	c.dirtyPods, c.dirtyDeps, c.nodesDirty = map[string]bool{}, map[string]bool{}, false
	first := !c.resetSent["pods"]
	c.resetSent["pods"], c.resetSent["deployments"], c.resetSent["nodes"] = true, true, true
	c.mu.Unlock()

	if first {
		c.emit.Emit(EventDelta, Delta{Cluster: c.id, Kind: "pods", Reset: true, Upserts: toAny(c.allPodRows(env, now)), Deletes: []string{}})
		c.emit.Emit(EventDelta, Delta{Cluster: c.id, Kind: "deployments", Reset: true, Upserts: toAny(c.allDeploymentRows(env, now)), Deletes: []string{}})
		c.emit.Emit(EventDelta, Delta{Cluster: c.id, Kind: "nodes", Reset: true, Upserts: toAny(c.allNodeRows(env, now)), Deletes: []string{}})
		return
	}
	if len(pods) > 0 && c.pods != nil {
		d := Delta{Cluster: c.id, Kind: "pods", Upserts: []any{}, Deletes: []string{}}
		for key := range pods {
			ns, name, _ := strings.Cut(key, "/")
			p, err := c.pods.Pods(ns).Get(name)
			if err != nil {
				d.Deletes = append(d.Deletes, c.id+"/"+key)
				continue
			}
			d.Upserts = append(d.Upserts, c.podRow(p, env, now))
		}
		c.emit.Emit(EventDelta, d)
	}
	if len(deps) > 0 && c.deploys != nil {
		d := Delta{Cluster: c.id, Kind: "deployments", Upserts: []any{}, Deletes: []string{}}
		for key := range deps {
			ns, name, _ := strings.Cut(key, "/")
			dep, err := c.deploys.Deployments(ns).Get(name)
			if err != nil {
				d.Deletes = append(d.Deletes, c.id+"/"+key)
				continue
			}
			d.Upserts = append(d.Upserts, c.deploymentRow(dep, env, now))
		}
		c.emit.Emit(EventDelta, d)
	}
	if nodes && c.nodes != nil {
		c.emit.Emit(EventDelta, Delta{Cluster: c.id, Kind: "nodes", Reset: true, Upserts: toAny(c.allNodeRows(env, now)), Deletes: []string{}})
	}
}

func toAny[T any](rows []T) []any {
	out := make([]any, len(rows))
	for i := range rows {
		out[i] = rows[i]
	}
	return out
}

func (c *clusterConn) podRow(p *corev1.Pod, env Environment, now time.Time) PodRow {
	c.mu.Lock()
	u, ok := c.podUsage[p.Namespace+"/"+p.Name]
	c.mu.Unlock()
	var usage *Usage
	if ok {
		usage = &u
	}
	return ToPodRow(p, c.id, env, usage, PodOwner(p, c.ownerOf), now)
}

func (c *clusterConn) allPodRows(env Environment, now time.Time) []PodRow {
	if c.pods == nil {
		return nil
	}
	list, _ := c.pods.List(labels.Everything())
	rows := make([]PodRow, 0, len(list))
	for _, p := range list {
		rows = append(rows, c.podRow(p, env, now))
	}
	return rows
}

func (c *clusterConn) deploymentRow(d *appsv1.Deployment, env Environment, now time.Time) DeploymentRow {
	var owned []*appsv1.ReplicaSet
	if c.rsets != nil {
		all, _ := c.rsets.ReplicaSets(d.Namespace).List(labels.Everything())
		for _, rs := range all {
			if o := metav1.GetControllerOf(rs); o != nil && o.UID == d.UID {
				owned = append(owned, rs)
			}
		}
	}
	var hpa *autoscalingv2.HorizontalPodAutoscaler
	if c.hpas != nil {
		all, _ := c.hpas.HorizontalPodAutoscalers(d.Namespace).List(labels.Everything())
		for _, h := range all {
			if h.Spec.ScaleTargetRef.Kind == "Deployment" && h.Spec.ScaleTargetRef.Name == d.Name {
				hpa = h
			}
		}
	}
	return ToDeploymentRow(d, c.id, env, owned, hpa, c.deploymentUsage(d), now)
}

// deploymentUsage sums current usage of the Deployment's pods, against requests and limits.
func (c *clusterConn) deploymentUsage(d *appsv1.Deployment) *DeploymentUsage {
	if c.pods == nil || d.Spec.Selector == nil {
		return nil
	}
	sel, err := metav1.LabelSelectorAsSelector(d.Spec.Selector)
	if err != nil {
		return nil
	}
	pods, _ := c.pods.Pods(d.Namespace).List(sel)
	c.mu.Lock()
	defer c.mu.Unlock()
	var u DeploymentUsage
	have := false
	for _, p := range pods {
		cr, _, _, ml := PodRequests(p)
		u.CPURequestMilli += int(cr)
		u.MemoryLimitMiB += int(ml / (1024 * 1024))
		if m, ok := c.podUsage[p.Namespace+"/"+p.Name]; ok {
			u.CPUMilli += m.CPUMilli
			u.MemoryMiB += m.MemoryMiB
			have = true
		}
	}
	if !have {
		return nil
	}
	return &u
}

func (c *clusterConn) allDeploymentRows(env Environment, now time.Time) []DeploymentRow {
	if c.deploys == nil {
		return nil
	}
	list, _ := c.deploys.List(labels.Everything())
	rows := make([]DeploymentRow, 0, len(list))
	for _, d := range list {
		rows = append(rows, c.deploymentRow(d, env, now))
	}
	return rows
}

func (c *clusterConn) allNodeRows(env Environment, now time.Time) []NodeRow {
	if c.nodes == nil {
		return nil
	}
	list, _ := c.nodes.List(labels.Everything())
	byNode := map[string][]*corev1.Pod{}
	if c.pods != nil {
		pods, _ := c.pods.List(labels.Everything())
		for _, p := range pods {
			if p.Spec.NodeName != "" {
				byNode[p.Spec.NodeName] = append(byNode[p.Spec.NodeName], p)
			}
		}
	}
	rows := make([]NodeRow, 0, len(list))
	c.mu.Lock()
	usage := c.nodeUsage
	c.mu.Unlock()
	for _, n := range list {
		var u *Usage
		if v, ok := usage[n.Name]; ok {
			u = &v
		}
		rows = append(rows, ToNodeRow(n, c.id, env, byNode[n.Name], u, now))
	}
	return rows
}

// metricsLoop polls metrics-server. It reports current usage only; the
// samples kept here start when Clustrail connected and are labeled that way.
func (c *clusterConn) metricsLoop(ctx context.Context) {
	tick := func() {
		pm, err := c.metrics.MetricsV1beta1().PodMetricses("").List(ctx, metav1.ListOptions{})
		if err == nil {
			podUsage := make(map[string]Usage, len(pm.Items))
			now := time.Now()
			for _, m := range pm.Items {
				var u Usage
				for _, ct := range m.Containers {
					cpu := int(ct.Usage.Cpu().MilliValue())
					mem := int(ct.Usage.Memory().Value() / (1024 * 1024))
					u.CPUMilli += cpu
					u.MemoryMiB += mem
					c.samples.add(m.Namespace+"/"+m.Name+"/"+ct.Name, now, float32(mem))
				}
				podUsage[m.Namespace+"/"+m.Name] = u
			}
			c.mu.Lock()
			c.podUsage = podUsage
			for k := range podUsage {
				c.dirtyPods[k] = true
			}
			if c.deploys != nil {
				all, _ := c.deploys.List(labels.Everything())
				for _, d := range all {
					c.dirtyDeps[d.Namespace+"/"+d.Name] = true
				}
			}
			c.mu.Unlock()
		}
		nm, err := c.metrics.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{})
		if err == nil {
			nodeUsage := make(map[string]Usage, len(nm.Items))
			for _, m := range nm.Items {
				nodeUsage[m.Name] = Usage{CPUMilli: int(m.Usage.Cpu().MilliValue()), MemoryMiB: int(m.Usage.Memory().Value() / (1024 * 1024))}
			}
			c.mu.Lock()
			c.nodeUsage = nodeUsage
			c.nodesDirty = true
			c.mu.Unlock()
		}
	}
	tick()
	t := time.NewTicker(metricsInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick()
		}
	}
}

// probeLoop measures latency and notices recovery after a lost watch.
func (c *clusterConn) probeLoop(ctx context.Context, onLatency func(ms int, err error)) {
	t := time.NewTicker(probeInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			start := time.Now()
			_, err := c.client.Discovery().RESTClient().Get().AbsPath("/readyz").DoRaw(ctx)
			if err != nil && apierrors.IsForbidden(err) {
				err = nil // /readyz may be restricted; reaching RBAC proves the server answers
			}
			onLatency(int(time.Since(start).Milliseconds()), err)
		}
	}
}

func (c *clusterConn) region() string {
	if c.nodes == nil {
		return ""
	}
	list, _ := c.nodes.List(labels.Everything())
	for _, n := range list {
		if r := n.Labels["topology.kubernetes.io/region"]; r != "" {
			return r
		}
	}
	return ""
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return fmt.Sprint(err)
}
