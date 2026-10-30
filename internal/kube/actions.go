package kube

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/types"
)

// ErrReadOnly is returned for any change on a context set to Read-only in
// Clustrail. It is a guard against mistakes, not a substitute for RBAC.
var ErrReadOnly = errors.New("this context is read-only in Clustrail")

func (m *Manager) writable(id string) (*clusterConn, error) {
	m.mu.Lock()
	st := m.state[id]
	m.mu.Unlock()
	if st == nil {
		return nil, fmt.Errorf("unknown context %q", id)
	}
	if st.ReadOnly {
		return nil, ErrReadOnly
	}
	return m.conn(id)
}

func actionCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 30*time.Second)
}

var fieldManager = metav1.PatchOptions{FieldManager: "clustrail"}

// evictRetry is how long a drain waits before retrying evictions a PodDisruptionBudget refused.
var evictRetry = 5 * time.Second

func (m *Manager) DeletePod(cluster, ns, name string) error {
	c, err := m.writable(cluster)
	if err != nil {
		return err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	return c.client.CoreV1().Pods(ns).Delete(ctx, name, metav1.DeleteOptions{})
}

// RestartDeployment does what `kubectl rollout restart` does: it stamps the pod template.
func (m *Manager) RestartDeployment(cluster, ns, name string) error {
	c, err := m.writable(cluster)
	if err != nil {
		return err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	patch := fmt.Sprintf(`{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":%q}}}}}`, time.Now().Format(time.RFC3339))
	_, err = c.client.AppsV1().Deployments(ns).Patch(ctx, name, types.StrategicMergePatchType, []byte(patch), fieldManager)
	return err
}

func (m *Manager) ScaleDeployment(cluster, ns, name string, replicas int32) error {
	c, err := m.writable(cluster)
	if err != nil {
		return err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	s, err := c.client.AppsV1().Deployments(ns).GetScale(ctx, name, metav1.GetOptions{})
	if err != nil {
		return err
	}
	s.Spec.Replicas = replicas
	_, err = c.client.AppsV1().Deployments(ns).UpdateScale(ctx, name, s, metav1.UpdateOptions{FieldManager: "clustrail"})
	return err
}

func (m *Manager) SetDeploymentPaused(cluster, ns, name string, paused bool) error {
	c, err := m.writable(cluster)
	if err != nil {
		return err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	_, err = c.client.AppsV1().Deployments(ns).Patch(ctx, name, types.StrategicMergePatchType, []byte(fmt.Sprintf(`{"spec":{"paused":%t}}`, paused)), fieldManager)
	return err
}

func (m *Manager) DeleteDeployment(cluster, ns, name string) error {
	c, err := m.writable(cluster)
	if err != nil {
		return err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	fg := metav1.DeletePropagationForeground
	return c.client.AppsV1().Deployments(ns).Delete(ctx, name, metav1.DeleteOptions{PropagationPolicy: &fg})
}

// RollbackDeployment does what `kubectl rollout undo --to-revision` does: it
// copies the pod template of that revision's ReplicaSet into the Deployment.
func (m *Manager) RollbackDeployment(cluster, ns, name string, revision int64) error {
	c, err := m.writable(cluster)
	if err != nil {
		return err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	d, err := c.client.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return err
	}
	sel, err := metav1.LabelSelectorAsSelector(d.Spec.Selector)
	if err != nil {
		return err
	}
	list, err := c.client.AppsV1().ReplicaSets(ns).List(ctx, metav1.ListOptions{LabelSelector: sel.String()})
	if err != nil {
		return err
	}
	var target *appsv1.ReplicaSet
	for i := range list.Items {
		rs := &list.Items[i]
		if o := metav1.GetControllerOf(rs); o != nil && o.UID == d.UID && revisionOf(rs) == revision {
			target = rs
		}
	}
	if target == nil {
		return fmt.Errorf("revision %d of %s not found (revisionHistoryLimit may have removed it)", revision, name)
	}
	tmpl := target.Spec.Template.DeepCopy()
	delete(tmpl.Labels, appsv1.DefaultDeploymentUniqueLabelKey)
	patch, err := json.Marshal(map[string]any{
		"metadata": map[string]any{"annotations": map[string]any{"deployment.kubernetes.io/change-cause": fmt.Sprintf("rollback to revision %d (Clustrail)", revision)}},
		"spec":     map[string]any{"template": tmpl},
	})
	if err != nil {
		return err
	}
	_, err = c.client.AppsV1().Deployments(ns).Patch(ctx, name, types.StrategicMergePatchType, patch, fieldManager)
	return err
}

func (m *Manager) SetNodeCordoned(cluster, node string, cordoned bool, user string) error {
	c, err := m.writable(cluster)
	if err != nil {
		return err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	return cordon(ctx, c, node, cordoned, user)
}

func cordon(ctx context.Context, c *clusterConn, node string, on bool, user string) error {
	ann := "null"
	if on && user != "" {
		ann = fmt.Sprintf("%q", user)
	}
	patch := fmt.Sprintf(`{"metadata":{"annotations":{"clustrail.io/cordoned-by":%s}},"spec":{"unschedulable":%t}}`, ann, on)
	_, err := c.client.CoreV1().Nodes().Patch(ctx, node, types.StrategicMergePatchType, []byte(patch), fieldManager)
	return err
}

// DrainOptions mirror kubectl drain's flags.
type DrainOptions struct {
	Force          bool `json:"force"`
	DeleteEmptyDir bool `json:"deleteEmptyDir"`
	TimeoutSec     int  `json:"timeoutSec"`
}

// Job is a background operation shown as a progress toast.
type Job struct {
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	Progress float64 `json:"progress"`
	Detail   string  `json:"detail"`
	Done     bool    `json:"done,omitempty"`
	Error    string  `json:"error,omitempty"`
}

// DrainPlan is what `kubectl drain` would do, computed before anything changes.
type DrainPlan struct {
	Evict     []string `json:"evict"`
	DaemonSet []string `json:"daemonSet"`
	Unmanaged []string `json:"unmanaged"`
	EmptyDir  []string `json:"emptyDir"`
	Blocked   string   `json:"blocked,omitempty"`
	// Pods whose PodDisruptionBudget allows no disruption right now; eviction is retried for them.
	PDBBlocked []string `json:"pdbBlocked"`
	PDB        string   `json:"pdb,omitempty"`
}

func drainPlan(pods []corev1.Pod, opts DrainOptions) DrainPlan {
	p := DrainPlan{Evict: []string{}, DaemonSet: []string{}, Unmanaged: []string{}, EmptyDir: []string{}, PDBBlocked: []string{}}
	for _, pod := range pods {
		if pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed {
			continue
		}
		if _, mirror := pod.Annotations[corev1.MirrorPodAnnotationKey]; mirror {
			continue
		}
		key := pod.Namespace + "/" + pod.Name
		ctrl := metav1.GetControllerOf(&pod)
		if ctrl != nil && ctrl.Kind == "DaemonSet" {
			p.DaemonSet = append(p.DaemonSet, key)
			continue
		}
		if ctrl == nil {
			p.Unmanaged = append(p.Unmanaged, key)
		}
		for _, v := range pod.Spec.Volumes {
			if v.EmptyDir != nil {
				p.EmptyDir = append(p.EmptyDir, key)
				break
			}
		}
		p.Evict = append(p.Evict, key)
	}
	switch {
	case len(p.Unmanaged) > 0 && !opts.Force:
		p.Blocked = fmt.Sprintf("%d pods are not managed by a controller (use force)", len(p.Unmanaged))
	case len(p.EmptyDir) > 0 && !opts.DeleteEmptyDir:
		p.Blocked = fmt.Sprintf("%d pods use emptyDir; their data is deleted (use delete emptyDir data)", len(p.EmptyDir))
	}
	return p
}

// DrainNode cordons the node and evicts its pods through the Eviction API, so
// PodDisruptionBudgets are respected; evictions refused by a PDB are retried
// until the timeout. Progress is reported as Job events.
func (m *Manager) DrainNode(cluster, node string, opts DrainOptions, user string) (string, error) {
	c, err := m.writable(cluster)
	if err != nil {
		return "", err
	}
	ctx, cancel := actionCtx()
	pods, err := c.client.CoreV1().Pods("").List(ctx, metav1.ListOptions{FieldSelector: fields.OneTermEqualSelector("spec.nodeName", node).String()})
	cancel()
	if err != nil {
		return "", err
	}
	plan := drainPlan(pods.Items, opts)
	if plan.Blocked != "" {
		return "", errors.New("drain refused: " + plan.Blocked)
	}
	jobID := fmt.Sprintf("drain-%s-%s-%d", cluster, node, time.Now().UnixMilli())
	short := strings.SplitN(node, ".", 2)[0]
	timeout := time.Duration(max(opts.TimeoutSec, 30)) * time.Second
	go func() {
		ctx, cancel := context.WithTimeout(c.ctx, timeout)
		defer cancel()
		report := func(j Job) { j.ID, j.Title = jobID, "Draining "+short; m.emit.Emit(EventJob, j) }
		if err := cordon(ctx, c, node, true, user); err != nil {
			report(Job{Done: true, Error: err.Error()})
			return
		}
		pending := append([]string(nil), plan.Evict...)
		total := len(pending)
		for len(pending) > 0 {
			var blocked []string
			var lastErr error
			for _, key := range pending {
				ns, name, _ := strings.Cut(key, "/")
				err := c.client.PolicyV1().Evictions(ns).Evict(ctx, &policyv1.Eviction{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}})
				switch {
				case err == nil, apierrors.IsNotFound(err):
				case apierrors.IsTooManyRequests(err):
					blocked = append(blocked, key) // a PodDisruptionBudget allows no disruption now
					lastErr = err
				default:
					report(Job{Done: true, Error: fmt.Sprintf("evicting %s: %v", key, err)})
					return
				}
			}
			done := total - len(blocked)
			detail := fmt.Sprintf("%d of %d evicted", done, total)
			if len(blocked) > 0 {
				detail += fmt.Sprintf(" · %d waiting for PodDisruptionBudget", len(blocked))
			}
			report(Job{Progress: float64(done) / float64(max(total, 1)), Detail: detail})
			pending = blocked
			if len(pending) == 0 {
				break
			}
			select {
			case <-ctx.Done():
				report(Job{Done: true, Error: fmt.Sprintf("timed out after %s: %d pods not evicted (%v)", timeout, len(pending), lastErr)})
				return
			case <-time.After(evictRetry):
			}
		}
		report(Job{Done: true, Progress: 1, Detail: fmt.Sprintf("%d pods evicted · node stays cordoned", total)})
	}()
	return jobID, nil
}

// PreviewDrain returns the drain plan without changing anything.
func (m *Manager) PreviewDrain(cluster, node string, opts DrainOptions) (DrainPlan, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return DrainPlan{}, err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	pods, err := c.client.CoreV1().Pods("").List(ctx, metav1.ListOptions{FieldSelector: fields.OneTermEqualSelector("spec.nodeName", node).String()})
	if err != nil {
		return DrainPlan{}, err
	}
	plan := drainPlan(pods.Items, opts)
	// PodDisruptionBudgets that allow no disruption now will refuse these evictions.
	byKey := map[string]*corev1.Pod{}
	namespaces := map[string]bool{}
	for i := range pods.Items {
		p := &pods.Items[i]
		byKey[p.Namespace+"/"+p.Name] = p
		namespaces[p.Namespace] = true
	}
	for ns := range namespaces {
		pdbs, err := c.client.PolicyV1().PodDisruptionBudgets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			continue
		}
		for i := range pdbs.Items {
			pdb := &pdbs.Items[i]
			if pdb.Status.DisruptionsAllowed > 0 {
				continue
			}
			for _, key := range plan.Evict {
				if p := byKey[key]; p != nil && p.Namespace == ns && pdbMatches(pdb, p) {
					plan.PDBBlocked = append(plan.PDBBlocked, key)
					plan.PDB = pdb.Name
				}
			}
		}
	}
	return plan, nil
}

// RefreshGitOps asks the controller to re-read the source now.
func (m *Manager) RefreshGitOps(cluster, kind, ns, name string) error {
	c, err := m.writable(cluster)
	if err != nil {
		return err
	}
	gvr, err := c.gitops.gvrOf(kind)
	if err != nil {
		return err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	var patch string
	if kind == "Application" {
		patch = `{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"normal"}}}`
	} else {
		patch = fmt.Sprintf(`{"metadata":{"annotations":{"reconcile.fluxcd.io/requestedAt":%q}}}`, time.Now().Format(time.RFC3339Nano))
	}
	_, err = c.dynamic.Resource(gvr).Namespace(ns).Patch(ctx, name, types.MergePatchType, []byte(patch), fieldManager)
	return err
}

// SyncGitOps starts an Argo CD sync operation (the controller runs it), or
// for Flux requests a reconcile with its source.
func (m *Manager) SyncGitOps(cluster, kind, ns, name string) error {
	c, err := m.writable(cluster)
	if err != nil {
		return err
	}
	gvr, err := c.gitops.gvrOf(kind)
	if err != nil {
		return err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	if kind != "Application" {
		return m.RefreshGitOps(cluster, kind, ns, name)
	}
	app, err := c.dynamic.Resource(gvr).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return err
	}
	if _, running, _ := unstructuredNested(app.Object, "operation"); running {
		return errors.New("a sync operation is already running")
	}
	prune, _, _ := unstructuredBool(app.Object, "spec", "syncPolicy", "automated", "prune")
	patch, _ := json.Marshal(map[string]any{"operation": map[string]any{
		"initiatedBy": map[string]any{"username": "clustrail"},
		"sync":        map[string]any{"revision": str(app.Object, "spec", "source", "targetRevision"), "prune": prune},
	}})
	_, err = c.dynamic.Resource(gvr).Namespace(ns).Patch(ctx, name, types.MergePatchType, patch, fieldManager)
	return err
}

func (m *Manager) SetGitOpsSuspended(cluster, kind, ns, name string, suspended bool) error {
	c, err := m.writable(cluster)
	if err != nil {
		return err
	}
	if kind == "Application" {
		return errors.New("Argo CD Applications have no suspend; turn off automated sync instead")
	}
	gvr, err := c.gitops.gvrOf(kind)
	if err != nil {
		return err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	_, err = c.dynamic.Resource(gvr).Namespace(ns).Patch(ctx, name, types.MergePatchType, []byte(fmt.Sprintf(`{"spec":{"suspend":%t}}`, suspended)), fieldManager)
	return err
}
