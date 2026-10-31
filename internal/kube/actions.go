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

// ErrTargetChanged is returned for any change on a context whose kubeconfig
// now points at another server than the one confirmed in Clustrail.
var ErrTargetChanged = errors.New("this context now points to another API server; confirm it in Connections before making changes")

func (m *Manager) writable(id string) (*clusterConn, error) {
	// A kubeconfig edited in the last seconds is read now, so the change goes
	// where the context points, never through a connection built for an old target.
	m.mu.Lock()
	changed := m.kc != nil && m.kc.Changed(m.store.ExtraKubeconfigs())
	m.mu.Unlock()
	if changed {
		m.reload()
	}
	m.mu.Lock()
	st := m.state[id]
	var target *TargetChange
	if st != nil {
		target = st.TargetChanged
	}
	m.mu.Unlock()
	if st == nil {
		return nil, fmt.Errorf("unknown context %q", id)
	}
	if st.ReadOnly {
		return nil, ErrReadOnly
	}
	if target != nil {
		return nil, ErrTargetChanged
	}
	return m.conn(id)
}

func actionCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 30*time.Second)
}

var fieldManager = metav1.PatchOptions{FieldManager: "clustrail"}

// evictRetry is how long a drain waits before retrying evictions a PodDisruptionBudget refused.
var evictRetry = 5 * time.Second

// deleteOptions carries the UID of the object the user confirmed as a
// precondition, so an object recreated under the same name (a StatefulSet
// pod, a re-applied manifest) is not deleted in its place.
func deleteOptions(uid string, propagation metav1.DeletionPropagation) metav1.DeleteOptions {
	opts := metav1.DeleteOptions{}
	if propagation != "" {
		opts.PropagationPolicy = &propagation
	}
	if uid != "" {
		u := types.UID(uid)
		opts.Preconditions = &metav1.Preconditions{UID: &u}
	}
	return opts
}

// replacedError explains a failed UID precondition.
func replacedError(err error, uid, kind, name string) error {
	if err != nil && uid != "" && apierrors.IsConflict(err) && strings.Contains(err.Error(), "UID") {
		return fmt.Errorf("%s %s was replaced by a new object with the same name after you confirmed; nothing was deleted", kind, name)
	}
	return err
}

func (m *Manager) DeletePod(cluster, ns, name, uid string) error {
	c, err := m.writable(cluster)
	if err != nil {
		return err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	return replacedError(c.client.CoreV1().Pods(ns).Delete(ctx, name, deleteOptions(uid, "")), uid, "pod", name)
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

func (m *Manager) DeleteDeployment(cluster, ns, name, uid string) error {
	c, err := m.writable(cluster)
	if err != nil {
		return err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	err = c.client.AppsV1().Deployments(ns).Delete(ctx, name, deleteOptions(uid, metav1.DeletePropagationForeground))
	return replacedError(err, uid, "deployment", name)
}

// RollbackDeployment does what `kubectl rollout undo --to-revision` does: the
// pod template of that revision's ReplicaSet replaces the Deployment's whole
// template (containers added since then go too). fromRevision is the revision
// the user saw when confirming (0: not checked): if the Deployment moved on
// since, nothing is changed. The update carries the resourceVersion it read, so
// a change in between is refused too.
func (m *Manager) RollbackDeployment(cluster, ns, name string, revision, fromRevision int64) error {
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
	if cur := revisionOf(d); fromRevision > 0 && cur != fromRevision {
		return fmt.Errorf("%s is at revision %d now, not %d as when you confirmed; nothing was rolled back", name, cur, fromRevision)
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
	d.Spec.Template = *tmpl
	if d.Annotations == nil {
		d.Annotations = map[string]string{}
	}
	d.Annotations["kubernetes.io/change-cause"] = fmt.Sprintf("rollback to revision %d (Clustrail)", revision)
	_, err = c.client.AppsV1().Deployments(ns).Update(ctx, d, metav1.UpdateOptions{FieldManager: "clustrail"})
	if apierrors.IsConflict(err) {
		return fmt.Errorf("%s changed while rolling back; nothing was rolled back, try again", name)
	}
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

// DrainNode cordons the node, evicts its pods through the Eviction API (so
// PodDisruptionBudgets are respected; refused evictions are retried) and waits
// until the evicted pods are gone, like kubectl drain: an accepted eviction
// only starts a pod's termination (grace period, preStop hooks, finalizers).
// Progress is reported as Job events; Done means the pods have left the node.
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
	// A pod recreated under the same name (StatefulSet) is a new pod: compare UIDs.
	uids := map[string]types.UID{}
	for i := range pods.Items {
		uids[pods.Items[i].Namespace+"/"+pods.Items[i].Name] = pods.Items[i].UID
	}
	jobID := fmt.Sprintf("drain-%s-%s-%d", cluster, node, time.Now().UnixMilli())
	short := strings.SplitN(node, ".", 2)[0]
	timeout := max(time.Duration(opts.TimeoutSec)*time.Second, drainMinTimeout)
	safeGo("drain", func(err error) {
		m.emit.Emit(EventJob, Job{ID: jobID, Title: "Draining " + short, Done: true, Error: err.Error()})
	}, func() {
		ctx, cancel := context.WithTimeout(c.ctx, timeout)
		defer cancel()
		report := func(j Job) { j.ID, j.Title = jobID, "Draining "+short; m.emit.Emit(EventJob, j) }
		if err := cordon(ctx, c, node, true, user); err != nil {
			report(Job{Done: true, Error: err.Error()})
			return
		}
		total := len(plan.Evict)
		pending := append([]string(nil), plan.Evict...) // not evicted yet
		var evicted []string                            // eviction accepted, pod not gone yet
		gone := 0
		var lastEvict time.Time
		var pdbErr error
		for {
			// Stage 1: evict, retrying PDB refusals every evictRetry.
			if len(pending) > 0 && time.Since(lastEvict) >= evictRetry {
				lastEvict = time.Now()
				var blocked []string
				for _, key := range pending {
					ns, name, _ := strings.Cut(key, "/")
					// Only the pod that was planned: a pod recreated under the same name is not evicted.
					uid := uids[key]
					err := c.client.PolicyV1().Evictions(ns).Evict(ctx, &policyv1.Eviction{
						ObjectMeta:    metav1.ObjectMeta{Name: name, Namespace: ns},
						DeleteOptions: &metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &uid}},
					})
					switch {
					case err == nil, apierrors.IsNotFound(err), apierrors.IsConflict(err):
						evicted = append(evicted, key)
					case apierrors.IsTooManyRequests(err):
						blocked = append(blocked, key) // a PodDisruptionBudget allows no disruption now
						pdbErr = err
					case ctx.Err() != nil:
						blocked = append(blocked, key) // ended below with the reason
					default:
						report(Job{Done: true, Error: fmt.Sprintf("evicting %s: %v", key, err)})
						return
					}
				}
				pending = blocked
			}
			// Stage 2: wait for evicted pods to be deleted (or replaced by a new pod of the same name).
			// Only a read that shows the pod gone counts; any failed read keeps it.
			var terminating []string
			for _, key := range evicted {
				ns, name, _ := strings.Cut(key, "/")
				p, err := c.client.CoreV1().Pods(ns).Get(ctx, name, metav1.GetOptions{})
				switch {
				case apierrors.IsNotFound(err), err == nil && p.UID != uids[key]:
					gone++
				case err != nil:
					terminating = append(terminating, key+" (state unknown)")
				default:
					terminating = append(terminating, key+terminationNote(p))
				}
			}
			evicted = stripNotes(terminating)
			accepted := total - len(pending)
			detail := fmt.Sprintf("%d of %d evicted · %d gone", accepted, total, gone)
			if len(pending) > 0 {
				detail += fmt.Sprintf(" · %d waiting for PodDisruptionBudget", len(pending))
			}
			if len(evicted) > 0 {
				detail += fmt.Sprintf(" · %d terminating", len(evicted))
			}
			if len(pending) == 0 && len(evicted) == 0 {
				report(Job{Done: true, Progress: 1, Detail: fmt.Sprintf("%d pods evicted and gone · node stays cordoned", total)})
				return
			}
			report(Job{Progress: float64(accepted+gone) / float64(2*max(total, 1)), Detail: detail})
			select {
			case <-ctx.Done():
				var parts []string
				if len(pending) > 0 {
					note := ""
					if pdbErr != nil {
						note = fmt.Sprintf(" (%v)", pdbErr)
					}
					parts = append(parts, fmt.Sprintf("%d not evicted%s", len(pending), note))
				}
				if len(terminating) > 0 {
					parts = append(parts, fmt.Sprintf("%d still terminating: %s", len(terminating), strings.Join(firstN(terminating, 5), ", ")))
				}
				reason := fmt.Sprintf("timed out after %s", timeout)
				if c.ctx.Err() != nil {
					reason = "stopped: the connection to the cluster closed"
				}
				report(Job{Done: true, Error: fmt.Sprintf("%s: %s · the node is cordoned but not empty", reason, strings.Join(parts, "; "))})
				return
			case <-time.After(drainPoll):
			}
		}
	})
	return jobID, nil
}

// drainPoll is how often a drain checks whether evicted pods are gone.
var drainPoll = 2 * time.Second

// drainMinTimeout is the shortest drain timeout accepted.
var drainMinTimeout = 30 * time.Second

// terminationNote says why a pod is still there: " (finalizers: a, b)", " (terminating, grace 300s)".
func terminationNote(p *corev1.Pod) string {
	switch {
	case p.DeletionTimestamp != nil && len(p.Finalizers) > 0:
		return " (finalizers: " + strings.Join(p.Finalizers, ", ") + ")"
	case p.DeletionTimestamp != nil && p.DeletionGracePeriodSeconds != nil:
		return fmt.Sprintf(" (terminating, grace %ds)", *p.DeletionGracePeriodSeconds)
	case p.DeletionTimestamp != nil:
		return " (terminating)"
	}
	return " (not deleted yet)"
}

func stripNotes(keys []string) []string {
	out := make([]string, len(keys))
	for i, k := range keys {
		out[i], _, _ = strings.Cut(k, " (")
	}
	return out
}

func firstN(xs []string, n int) []string {
	if len(xs) > n {
		return append(append([]string{}, xs[:n]...), fmt.Sprintf("+%d more", len(xs)-n))
	}
	return xs
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
