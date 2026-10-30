package kube

import (
	"context"
	"errors"
	"fmt"
	"io"
	"k8s.io/apimachinery/pkg/api/meta"
	"net"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	authnv1 "k8s.io/api/authentication/v1"
	authzv1 "k8s.io/api/authorization/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/discovery"
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

	flushInterval = 250 * time.Millisecond
	probeInterval = 15 * time.Second
)

// metricsEvery is the metrics-server polling interval (Settings › Refresh & watch), in seconds.
var metricsEvery atomic.Int64

func init() { metricsEvery.Store(15) }

// SetMetricsInterval changes how often metrics-server is polled; running loops pick it up on their next tick.
func SetMetricsInterval(seconds int) {
	metricsEvery.Store(int64(min(max(seconds, 10), 300)))
}

// clusterConn is one connected context: clients, informers and the rows
// derived from them. Rows are rebuilt for changed objects only and sent to
// the frontend as deltas at most every flushInterval.
type clusterConn struct {
	id   string
	env  func() Environment
	emit Emitter

	rest   *rest.Config
	client kubernetes.Interface
	// disc has a request timeout; c.client has none so watches and streams stay open.
	disc    discovery.DiscoveryInterface
	dynamic dynamic.Interface
	metrics metricsclient.Interface

	cancel context.CancelFunc
	ctx    context.Context

	factory   informers.SharedInformerFactory
	nsFactory informers.SharedInformerFactory
	pods      listerscorev1.PodLister
	nodes     listerscorev1.NodeLister
	deploys   listersappsv1.DeploymentLister
	rsets     listersappsv1.ReplicaSetLister
	hpas      listersautoscalingv2.HorizontalPodAutoscalerLister
	helm      *helmWatcher
	gitops    *gitopsWatcher
	forbidden []Forbidden
	// fingerprint of the kubeconfig inputs this connection was built from (manager.go).
	fingerprint string
	// health tracks watches (and poll loops) that failed and have not caught up yet.
	health watchHealth
	// fallbackNS is the namespace listed instead when RBAC denies a resource
	// cluster-wide: the context's namespace, or "default".
	fallbackNS string
	// podsNS is "" when pods are watched cluster-wide, else fallbackNS.
	podsNS  string
	syncFns []cache.InformerSynced
	// streamPods: pods go to the UI through the streaming hub (podstream.go),
	// not as clustrail:delta events.
	streamPods bool
	podSubs    podSubscribers
	// started is set once start has filled the listers; readers on other goroutines check it first.
	started atomic.Bool
	kinds   kindIndex

	mu        sync.Mutex
	dirtyPods map[string]bool // ns/name
	dirtyDeps map[string]bool
	// nodesDirty rebuilds every node row (metrics ticks); dirtyNodes only the named ones.
	nodesDirty bool
	dirtyNodes map[string]bool
	// podsByNode and rsByOwner are informer indexes, so a node or Deployment
	// row is built from its own pods and ReplicaSets instead of a full scan.
	podsByNode cache.Indexer
	rsByOwner  cache.Indexer
	resetSent  map[string]bool
	podUsage   map[string]Usage // ns/name
	nodeUsage  map[string]Usage
	samples    *sampleStore
	onState    func(ConnectionState, error)
}

// Forbidden is a resource this identity cannot list cluster-wide. Shown is
// the one namespace listed instead, when that is allowed.
type Forbidden struct {
	Cluster   string `json:"cluster"`
	Namespace string `json:"namespace"`
	User      string `json:"user"`
	Resource  string `json:"resource"`
	Shown     string `json:"shown,omitempty"`
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
	// Discovery calls take no context, so they get a client with a deadline.
	dcfg := rest.CopyConfig(cfg)
	dcfg.Timeout = 20 * time.Second
	disc, err := discovery.NewDiscoveryClientForConfig(dcfg)
	if err != nil {
		return nil, err
	}
	c := connFromClients(id, env, emit, onState, client, dyn, mc)
	c.rest, c.disc = cfg, disc
	return c, nil
}

// connFromClients builds a connection around existing clients (tests use fakes).
func connFromClients(id string, env func() Environment, emit Emitter, onState func(ConnectionState, error), client kubernetes.Interface, dyn dynamic.Interface, mc metricsclient.Interface) *clusterConn {
	return &clusterConn{
		id: id, env: env, emit: emit, client: client, dynamic: dyn, metrics: mc,
		dirtyPods: map[string]bool{}, dirtyDeps: map[string]bool{}, dirtyNodes: map[string]bool{}, resetSent: map[string]bool{},
		podUsage: map[string]Usage{}, nodeUsage: map[string]Usage{}, samples: newSampleStore(120),
		onState: onState, disc: client.Discovery(),
	}
}

// probe checks reachability and credentials and learns version, identity and metrics support.
func (c *clusterConn) probe(ctx context.Context) (ConnectInfo, error) {
	var info ConnectInfo
	start := time.Now()
	v, err := c.disc.ServerVersion()
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
	if groups, err := c.disc.ServerGroups(); err == nil {
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
	return c.canListIn(ctx, group, resource, "")
}

// canListIn is canList for one namespace ("" means all namespaces).
func (c *clusterConn) canListIn(ctx context.Context, group, resource, ns string) bool {
	r, err := c.client.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, &authzv1.SelfSubjectAccessReview{
		Spec: authzv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authzv1.ResourceAttributes{Verb: "list", Group: group, Resource: resource, Namespace: ns}},
	}, metav1.CreateOptions{})
	return err != nil || r.Status.Allowed // on error, try and let the informer report
}

// scope decides where a namespaced resource is listed: cluster-wide when
// allowed, else in fallbackNS when that is allowed. ok is false when neither is.
// A denial is recorded either way so the UI can say what is missing.
func (c *clusterConn) scope(ctx context.Context, identity, group, resource, label string) (ns string, ok bool) {
	if c.canList(ctx, group, resource) {
		return "", true
	}
	f := Forbidden{Cluster: c.id, Namespace: "all namespaces", User: identity, Resource: label}
	if c.fallbackNS != "" && c.canListIn(ctx, group, resource, c.fallbackNS) {
		f.Shown = c.fallbackNS
		ns, ok = c.fallbackNS, true
	}
	c.forbidden = append(c.forbidden, f)
	return ns, ok
}

// start launches informers and the flush, probe and metrics loops.
func (c *clusterConn) start(parent context.Context, identity string, withMetrics bool) error {
	c.ctx, c.cancel = context.WithCancel(parent)
	ctx := c.ctx
	// managedFields are never read from the caches (YAML views fetch the live
	// object), and they are often the largest part of an object.
	c.factory = informers.NewSharedInformerFactoryWithOptions(c.client, 0, informers.WithTransform(stripManagedFields))

	add := func(inf cache.SharedIndexInformer, onChange func(obj any)) {
		c.syncFns = append(c.syncFns, inf.HasSynced)
		key := fmt.Sprintf("watch-%p", inf)
		_ = inf.SetWatchErrorHandler(func(_ *cache.Reflector, err error) {
			if errors.Is(err, context.Canceled) || ctx.Err() != nil {
				return
			}
			// Expired resourceVersions and closed watches are routine: the reflector re-lists on its own.
			if apierrors.IsResourceExpired(err) || apierrors.IsGone(err) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return
			}
			// The cache is behind until this informer lists or watches past where it stopped.
			rv := inf.LastSyncResourceVersion()
			c.health.fail(key, func() bool { return inf.LastSyncResourceVersion() != rv })
			c.onState(Reconnecting, err)
		})
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

	// Namespaced informers live in their own factory, used only for the
	// resources this identity may not list cluster-wide.
	var nsFactory informers.SharedInformerFactory
	factoryFor := func(ns string) informers.SharedInformerFactory {
		if ns == "" {
			return c.factory
		}
		if nsFactory == nil {
			nsFactory = informers.NewSharedInformerFactoryWithOptions(c.client, 0, informers.WithNamespace(ns), informers.WithTransform(stripManagedFields))
		}
		return nsFactory
	}
	// source returns the cache of one resource: an informer's (watch), or one
	// filled by listing every pollEvery (Settings › Update method: Poll).
	poll := pollMode.Load()
	source := func(inf func() cache.SharedIndexInformer, list func(context.Context) ([]any, error), indexers cache.Indexers, onChange func(obj any)) cache.Indexer {
		if poll {
			idx, synced := c.pollSource(ctx, list, indexers, onChange)
			c.syncFns = append(c.syncFns, synced)
			return idx
		}
		i := inf()
		if indexers != nil {
			_ = i.AddIndexers(indexers)
		}
		add(i, onChange)
		return i.GetIndexer()
	}

	if ns, ok := c.scope(ctx, identity, "", "pods", "pods"); ok {
		c.podsNS = ns
		idx := source(func() cache.SharedIndexInformer { return factoryFor(ns).Core().V1().Pods().Informer() },
			func(ctx context.Context) ([]any, error) {
				l, err := c.client.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
				return items(l, err, func() []corev1.Pod { return l.Items })
			},
			cache.Indexers{indexNode: func(obj any) ([]string, error) {
				if p, ok := obj.(*corev1.Pod); ok && p.Spec.NodeName != "" {
					return []string{p.Spec.NodeName}, nil
				}
				return nil, nil
			}},
			func(obj any) {
				if p, ok := obj.(*corev1.Pod); ok {
					c.publishPod(p.Namespace, p.Name)
					c.mu.Lock()
					c.dirtyPods[p.Namespace+"/"+p.Name] = true
					if p.Spec.NodeName != "" {
						c.dirtyNodes[p.Spec.NodeName] = true
					}
					c.mu.Unlock()
					if o := metav1.GetControllerOf(p); o != nil && o.Kind == "ReplicaSet" {
						if dep := c.deploymentOfRS(p.Namespace, o.Name); dep != "" {
							c.mu.Lock()
							c.dirtyDeps[p.Namespace+"/"+dep] = true
							c.mu.Unlock()
						}
					}
				}
			})
		c.pods, c.podsByNode = listerscorev1.NewPodLister(idx), idx
	}
	if c.canList(ctx, "", "nodes") { // cluster-scoped: no namespace to fall back to
		idx := source(func() cache.SharedIndexInformer { return c.factory.Core().V1().Nodes().Informer() },
			func(ctx context.Context) ([]any, error) {
				l, err := c.client.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
				return items(l, err, func() []corev1.Node { return l.Items })
			}, nil,
			func(obj any) {
				if n, ok := obj.(*corev1.Node); ok {
					c.mu.Lock()
					c.dirtyNodes[n.Name] = true
					c.mu.Unlock()
				}
			})
		c.nodes = listerscorev1.NewNodeLister(idx)
	} else {
		c.forbidden = append(c.forbidden, Forbidden{Cluster: c.id, Namespace: "cluster", User: identity, Resource: "nodes"})
	}
	if ns, ok := c.scope(ctx, identity, "apps", "deployments", "deployments"); ok {
		idx := source(func() cache.SharedIndexInformer { return factoryFor(ns).Apps().V1().Deployments().Informer() },
			func(ctx context.Context) ([]any, error) {
				l, err := c.client.AppsV1().Deployments(ns).List(ctx, metav1.ListOptions{})
				return items(l, err, func() []appsv1.Deployment { return l.Items })
			}, nil,
			func(obj any) {
				if d, ok := obj.(*appsv1.Deployment); ok {
					c.mu.Lock()
					c.dirtyDeps[d.Namespace+"/"+d.Name] = true
					c.mu.Unlock()
				}
			})
		c.deploys = listersappsv1.NewDeploymentLister(idx)
	}
	if ns, ok := c.scope(ctx, identity, "apps", "replicasets", "replicasets"); ok {
		idx := source(func() cache.SharedIndexInformer { return factoryFor(ns).Apps().V1().ReplicaSets().Informer() },
			func(ctx context.Context) ([]any, error) {
				l, err := c.client.AppsV1().ReplicaSets(ns).List(ctx, metav1.ListOptions{})
				return items(l, err, func() []appsv1.ReplicaSet { return l.Items })
			},
			cache.Indexers{indexOwner: func(obj any) ([]string, error) {
				if rs, ok := obj.(*appsv1.ReplicaSet); ok {
					if o := metav1.GetControllerOf(rs); o != nil {
						return []string{string(o.UID)}, nil
					}
				}
				return nil, nil
			}},
			func(obj any) {
				if rs, ok := obj.(*appsv1.ReplicaSet); ok {
					if o := metav1.GetControllerOf(rs); o != nil && o.Kind == "Deployment" {
						c.mu.Lock()
						c.dirtyDeps[rs.Namespace+"/"+o.Name] = true
						c.mu.Unlock()
					}
				}
			})
		c.rsets, c.rsByOwner = listersappsv1.NewReplicaSetLister(idx), idx
	}
	if ns, ok := c.scope(ctx, identity, "autoscaling", "horizontalpodautoscalers", "horizontalpodautoscalers"); ok {
		idx := source(func() cache.SharedIndexInformer {
			return factoryFor(ns).Autoscaling().V2().HorizontalPodAutoscalers().Informer()
		},
			func(ctx context.Context) ([]any, error) {
				l, err := c.client.AutoscalingV2().HorizontalPodAutoscalers(ns).List(ctx, metav1.ListOptions{})
				return items(l, err, func() []autoscalingv2.HorizontalPodAutoscaler { return l.Items })
			}, nil,
			func(obj any) {
				if h, ok := obj.(*autoscalingv2.HorizontalPodAutoscaler); ok && h.Spec.ScaleTargetRef.Kind == "Deployment" {
					c.mu.Lock()
					c.dirtyDeps[h.Namespace+"/"+h.Spec.ScaleTargetRef.Name] = true
					c.mu.Unlock()
				}
			})
		c.hpas = listersautoscalingv2.NewHorizontalPodAutoscalerLister(idx)
	}
	c.nsFactory = nsFactory

	c.helm = newHelmWatcher(c, identity)
	c.gitops = newGitOpsWatcher(c)

	c.factory.Start(ctx.Done())
	if nsFactory != nil {
		nsFactory.Start(ctx.Done())
	}
	c.helm.start(ctx)
	c.gitops.start(ctx)

	go c.flushLoop(ctx)
	defer c.started.Store(true)
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
	if c.nsFactory != nil {
		c.nsFactory.Shutdown()
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
	pods, deps, nodes, someNodes := c.dirtyPods, c.dirtyDeps, c.nodesDirty, c.dirtyNodes
	c.dirtyPods, c.dirtyDeps, c.nodesDirty, c.dirtyNodes = map[string]bool{}, map[string]bool{}, false, map[string]bool{}
	first := !c.resetSent["pods"]
	c.resetSent["pods"], c.resetSent["deployments"], c.resetSent["nodes"] = true, true, true
	c.mu.Unlock()

	if first {
		if !c.streamPods {
			c.emit.Emit(EventDelta, Delta{Cluster: c.id, Kind: "pods", Reset: true, Upserts: toAny(c.allPodRows(env, now)), Deletes: []string{}})
		}
		c.emit.Emit(EventDelta, Delta{Cluster: c.id, Kind: "deployments", Reset: true, Upserts: toAny(c.allDeploymentRows(env, now)), Deletes: []string{}})
		c.emit.Emit(EventDelta, Delta{Cluster: c.id, Kind: "nodes", Reset: true, Upserts: toAny(c.allNodeRows(env, now)), Deletes: []string{}})
		return
	}
	if len(pods) > 0 && c.pods != nil && !c.streamPods {
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
	} else if len(someNodes) > 0 && c.nodes != nil {
		c.mu.Lock()
		usage := c.nodeUsage
		c.mu.Unlock()
		d := Delta{Cluster: c.id, Kind: "nodes", Upserts: []any{}, Deletes: []string{}}
		for name := range someNodes {
			n, err := c.nodes.Get(name)
			if err != nil {
				d.Deletes = append(d.Deletes, c.id+"/"+name)
				continue
			}
			d.Upserts = append(d.Upserts, c.nodeRow(n, usage, env, now))
		}
		c.emit.Emit(EventDelta, d)
	}
}

const (
	indexNode  = "node"
	indexOwner = "owner"
)

// podsOn returns the pods scheduled to a node, from the pod index.
func (c *clusterConn) podsOn(node string) []*corev1.Pod {
	if c.podsByNode == nil {
		return nil
	}
	objs, _ := c.podsByNode.ByIndex(indexNode, node)
	out := make([]*corev1.Pod, 0, len(objs))
	for _, o := range objs {
		if p, ok := o.(*corev1.Pod); ok {
			out = append(out, p)
		}
	}
	return out
}

func (c *clusterConn) nodeRow(n *corev1.Node, usage map[string]Usage, env Environment, now time.Time) NodeRow {
	var u *Usage
	if v, ok := usage[n.Name]; ok {
		u = &v
	}
	return ToNodeRow(n, c.id, env, c.podsOn(n.Name), u, now)
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
	if c.rsByOwner != nil {
		objs, _ := c.rsByOwner.ByIndex(indexOwner, string(d.UID))
		for _, o := range objs {
			if rs, ok := o.(*appsv1.ReplicaSet); ok {
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
	rows := make([]NodeRow, 0, len(list))
	c.mu.Lock()
	usage := c.nodeUsage
	c.mu.Unlock()
	for _, n := range list {
		rows = append(rows, c.nodeRow(n, usage, env, now))
	}
	return rows
}

// metricsLoop polls metrics-server. It reports current usage only; the
// samples kept here start when Clustrail connected and are labeled that way.
func (c *clusterConn) metricsLoop(ctx context.Context) {
	tick := func() {
		pm, err := c.metrics.MetricsV1beta1().PodMetricses(c.podsNS).List(ctx, metav1.ListOptions{})
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
			// Samples of pods that are gone are dropped.
			c.samples.forget(func(key string) bool {
				ns, rest, _ := strings.Cut(key, "/")
				pod, _, _ := strings.Cut(rest, "/")
				_, ok := podUsage[ns+"/"+pod]
				return ok
			})
			// Only rows whose usage changed are sent again: their pod and its Deployment.
			c.mu.Lock()
			old := c.podUsage
			c.podUsage = podUsage
			changed := make([]string, 0, len(podUsage))
			for k, u := range podUsage {
				if prev, ok := old[k]; !ok || prev != u {
					changed = append(changed, k)
				}
			}
			for k := range old {
				if _, ok := podUsage[k]; !ok {
					changed = append(changed, k)
				}
			}
			for _, k := range changed {
				c.dirtyPods[k] = true
			}
			c.mu.Unlock()
			for _, k := range changed {
				ns, name, _ := strings.Cut(k, "/")
				c.publishPod(ns, name)
			}
			// Owner lookups use the listers only; c.mu is not held.
			deps := map[string]bool{}
			for _, k := range changed {
				ns, name, _ := strings.Cut(k, "/")
				if c.pods == nil {
					break
				}
				p, err := c.pods.Pods(ns).Get(name)
				if err != nil {
					continue
				}
				if o := metav1.GetControllerOf(p); o != nil && o.Kind == "ReplicaSet" {
					if dep := c.deploymentOfRS(ns, o.Name); dep != "" {
						deps[ns+"/"+dep] = true
					}
				}
			}
			c.mu.Lock()
			for k := range deps {
				c.dirtyDeps[k] = true
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
	// Samples from earlier sessions (kept for sampleMaxAge) come first.
	path := samplesPath(c.id)
	c.samples.load(path, time.Now(), sampleMaxAge)
	defer func() { _ = c.samples.save(path) }()
	lastSave := time.Now()
	tick()
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Duration(metricsEvery.Load()) * time.Second):
			tick()
			if time.Since(lastSave) > 5*time.Minute {
				lastSave = time.Now()
				_ = c.samples.save(path)
			}
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

// stripManagedFields drops metadata.managedFields from cached objects.
func stripManagedFields(obj any) (any, error) {
	if a, err := meta.Accessor(obj); err == nil {
		a.SetManagedFields(nil)
	}
	return obj, nil
}

// items turns a typed list's items into pointers for a cache.
func items[T any, L any](l L, err error, get func() []T) ([]any, error) {
	if err != nil {
		return nil, err
	}
	src := get()
	out := make([]any, len(src))
	for i := range src {
		out[i] = &src[i]
	}
	return out, nil
}

// pollSource fills a cache by listing every pollEvery and calls onChange for
// objects that were added, changed (new resourceVersion) or removed, like an
// informer's handlers would.
func (c *clusterConn) pollSource(ctx context.Context, list func(context.Context) ([]any, error), indexers cache.Indexers, onChange func(obj any)) (cache.Indexer, func() bool) {
	if indexers == nil {
		indexers = cache.Indexers{}
	}
	idx := cache.NewIndexer(cache.MetaNamespaceKeyFunc, indexers)
	every := pollEvery
	key := fmt.Sprintf("poll-%p", idx)
	var synced atomic.Bool
	go func() {
		for {
			lctx, cancel := context.WithTimeout(ctx, 60*time.Second)
			objs, err := list(lctx)
			cancel()
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				c.health.fail(key, nil) // behind until a list succeeds
				c.onState(Reconnecting, err)
			} else {
				c.health.ok(key)
				old := map[string]any{}
				for _, o := range idx.List() {
					if k, err := cache.MetaNamespaceKeyFunc(o); err == nil {
						old[k] = o
					}
				}
				var changed []any
				for _, o := range objs {
					_, _ = stripManagedFields(o)
					k, err := cache.MetaNamespaceKeyFunc(o)
					if err != nil {
						continue
					}
					prev, ok := old[k]
					delete(old, k)
					if !ok || resourceVersion(prev) != resourceVersion(o) {
						changed = append(changed, o)
					}
				}
				_ = idx.Replace(objs, "")
				synced.Store(true)
				for _, o := range changed {
					onChange(o)
				}
				for _, o := range old {
					onChange(o) // removed: handlers look it up and find it gone
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(every):
			}
		}
	}()
	return idx, synced.Load
}

func resourceVersion(obj any) string {
	if a, err := meta.Accessor(obj); err == nil {
		return a.GetResourceVersion()
	}
	return ""
}

// watchHealth says whether the caches are current. A failed watch is behind
// until its informer syncs past the resourceVersion it stopped at; a failed
// poll is behind until a list succeeds. An API server that answers proves
// neither.
type watchHealth struct {
	mu     sync.Mutex
	broken map[string]func() bool // key → caught up?
}

func (h *watchHealth) fail(key string, caughtUp func() bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.broken == nil {
		h.broken = map[string]func() bool{}
	}
	if _, ok := h.broken[key]; !ok {
		h.broken[key] = caughtUp
	}
}

func (h *watchHealth) ok(key string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.broken, key)
}

// behind drops the sources that caught up and counts the rest.
func (h *watchHealth) behind() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	for k, caughtUp := range h.broken {
		if caughtUp != nil && caughtUp() {
			delete(h.broken, k)
		}
	}
	return len(h.broken)
}
