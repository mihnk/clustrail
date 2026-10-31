package kube

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// Debugging a pod with an ephemeral container (`kubectl debug POD`) and a
// node with a privileged pod in its namespaces (`kubectl debug node/NODE`).

// DebugProfiles mirror kubectl debug --profile.
var DebugProfiles = []string{"general", "baseline", "restricted", "netadmin", "sysadmin"}

type DebugRequest struct {
	Cluster   string `json:"cluster"`
	Namespace string `json:"namespace"`
	Pod       string `json:"pod"`
	Image     string `json:"image"`
	// Target shares that container's process namespace (--target); "" for none.
	Target  string   `json:"target"`
	Profile string   `json:"profile"`
	Command []string `json:"command"`
}

// DebugContainer is the ephemeral container once it runs; a Shell tab execs into it.
type DebugContainer struct {
	Namespace string `json:"namespace"`
	Pod       string `json:"pod"`
	Container string `json:"container"`
}

// debugWait is how long a debug container or node shell may take to start (image pulls included).
var debugWait = 90 * time.Second

func randomSuffix(n int) string {
	const letters = "bcdfghjklmnpqrstvwxz2456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = letters[rand.IntN(len(letters))]
	}
	return string(b)
}

func debugSecurity(profile string) (*corev1.SecurityContext, error) {
	no, yes := false, true
	switch profile {
	case "", "general":
		return &corev1.SecurityContext{Capabilities: &corev1.Capabilities{Add: []corev1.Capability{"SYS_PTRACE"}}}, nil
	case "baseline":
		return nil, nil
	case "restricted":
		return &corev1.SecurityContext{
			RunAsNonRoot:             &yes,
			AllowPrivilegeEscalation: &no,
			Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
			SeccompProfile:           &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
		}, nil
	case "netadmin":
		return &corev1.SecurityContext{Capabilities: &corev1.Capabilities{Add: []corev1.Capability{"NET_ADMIN", "NET_RAW"}}}, nil
	case "sysadmin":
		return &corev1.SecurityContext{Privileged: &yes}, nil
	}
	return nil, fmt.Errorf("unknown debug profile %q", profile)
}

// AddDebugContainer adds an ephemeral container to a running pod and waits
// until it runs. Ephemeral containers cannot be removed: it stays in the pod
// spec until the pod is deleted.
func (m *Manager) AddDebugContainer(req DebugRequest) (DebugContainer, error) {
	c, err := m.writable(req.Cluster)
	if err != nil {
		return DebugContainer{}, err
	}
	if strings.TrimSpace(req.Image) == "" {
		return DebugContainer{}, fmt.Errorf("an image is required")
	}
	sc, err := debugSecurity(req.Profile)
	if err != nil {
		return DebugContainer{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), debugWait+15*time.Second)
	defer cancel()
	pods := c.client.CoreV1().Pods(req.Namespace)
	pod, err := pods.Get(ctx, req.Pod, metav1.GetOptions{})
	if err != nil {
		return DebugContainer{}, err
	}
	if pod.Status.Phase != corev1.PodRunning {
		return DebugContainer{}, fmt.Errorf("pod is %s; a debug container needs a running pod", strings.ToLower(string(pod.Status.Phase)))
	}
	if req.Target != "" && !hasContainer(pod, req.Target) {
		return DebugContainer{}, fmt.Errorf("pod has no container %q", req.Target)
	}
	cmd := req.Command
	if len(cmd) == 0 {
		cmd = []string{"sh"}
	}
	name := "debugger-" + randomSuffix(5)
	ec := corev1.EphemeralContainer{
		EphemeralContainerCommon: corev1.EphemeralContainerCommon{
			Name:                     name,
			Image:                    req.Image,
			Command:                  cmd,
			Stdin:                    true,
			TTY:                      true,
			ImagePullPolicy:          corev1.PullIfNotPresent,
			TerminationMessagePolicy: corev1.TerminationMessageReadFile,
			SecurityContext:          sc,
		},
		TargetContainerName: req.Target,
	}
	pod.Spec.EphemeralContainers = append(pod.Spec.EphemeralContainers, ec)
	if _, err := pods.UpdateEphemeralContainers(ctx, pod.Name, pod, metav1.UpdateOptions{FieldManager: "clustrail"}); err != nil {
		if apierrors.IsNotFound(err) {
			return DebugContainer{}, fmt.Errorf("the cluster does not support ephemeral containers (Kubernetes 1.25+): %w", err)
		}
		return DebugContainer{}, err
	}
	out := DebugContainer{Namespace: req.Namespace, Pod: req.Pod, Container: name}
	return out, waitRunning(ctx, c, req.Namespace, req.Pod, name, true)
}

func hasContainer(p *corev1.Pod, name string) bool {
	for _, ct := range p.Spec.Containers {
		if ct.Name == name {
			return true
		}
	}
	return false
}

// waitRunning waits for a container (ephemeral or not) to run, failing early
// on image pull errors and other terminal waiting reasons.
func waitRunning(ctx context.Context, c *clusterConn, ns, pod, container string, ephemeral bool) error {
	deadline := time.Now().Add(debugWait)
	for time.Now().Before(deadline) {
		p, err := c.client.CoreV1().Pods(ns).Get(ctx, pod, metav1.GetOptions{})
		if err != nil {
			return err
		}
		statuses := p.Status.ContainerStatuses
		if ephemeral {
			statuses = p.Status.EphemeralContainerStatuses
		}
		for _, cs := range statuses {
			if cs.Name != container {
				continue
			}
			switch {
			case cs.State.Running != nil:
				return nil
			case cs.State.Terminated != nil:
				t := cs.State.Terminated
				return fmt.Errorf("container %s exited: %s (exit %d) %s", container, orDefault(t.Reason, "Error"), t.ExitCode, t.Message)
			case cs.State.Waiting != nil:
				switch w := cs.State.Waiting; w.Reason {
				case "ErrImagePull", "ImagePullBackOff", "InvalidImageName", "CreateContainerConfigError", "CreateContainerError":
					return fmt.Errorf("container %s cannot start: %s %s", container, w.Reason, w.Message)
				}
			}
		}
		if !ephemeral && p.Status.Phase == corev1.PodFailed {
			return fmt.Errorf("pod failed: %s %s", p.Status.Reason, p.Status.Message)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return fmt.Errorf("container %s did not start within %s", container, debugWait)
}

type NodeShellRequest struct {
	Cluster   string `json:"cluster"`
	Node      string `json:"node"`
	Namespace string `json:"namespace"`
	Image     string `json:"image"`
}

// NodeShell is the privileged pod a node shell runs in.
type NodeShell struct {
	Namespace string `json:"namespace"`
	Pod       string `json:"pod"`
	Container string `json:"container"`
	// Command opens a shell in the node's root filesystem.
	Command []string `json:"command"`
}

const (
	nodeShellLabel = "clustrail.mihnk.org/node-shell"
	// installLabel names the installation that started a node shell.
	installLabel = "clustrail.mihnk.org/install"
	// nodeShellLifetime ends a node shell pod by itself if Clustrail could not
	// delete it (a crash, or quitting while the cluster was unreachable).
	nodeShellLifetime = 12 * time.Hour
)

type nodeShells struct {
	mu   sync.Mutex
	pods map[string]NodeShell // cluster/ns/pod
	uids map[string]types.UID // known once the pod is created
}

func (s *nodeShells) track(key string, sh NodeShell) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pods == nil {
		s.pods = map[string]NodeShell{}
	}
	s.pods[key] = sh
}

func (s *nodeShells) setUID(key string, uid types.UID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.uids == nil {
		s.uids = map[string]types.UID{}
	}
	s.uids[key] = uid
}

func (s *nodeShells) untrack(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.pods, key)
	delete(s.uids, key)
}

// StartNodeShell starts a privileged pod pinned to the node, with the host's
// PID, network and IPC namespaces and its root filesystem at /host, and waits
// until it runs. Pod Security admission on the namespace may refuse it.
func (m *Manager) StartNodeShell(req NodeShellRequest) (NodeShell, error) {
	c, err := m.writable(req.Cluster)
	if err != nil {
		return NodeShell{}, err
	}
	if req.Namespace == "" {
		req.Namespace = "kube-system"
	}
	if req.Image == "" {
		req.Image = "busybox:1.37"
	}
	ctx, cancel := context.WithTimeout(context.Background(), debugWait+15*time.Second)
	defer cancel()
	if _, err := c.client.CoreV1().Nodes().Get(ctx, req.Node, metav1.GetOptions{}); err != nil {
		return NodeShell{}, err
	}
	pod := nodeShellPod(req, m.store.InstallID())
	shell := NodeShell{
		Namespace: pod.Namespace, Pod: pod.Name, Container: "shell",
		Command: []string{"chroot", "/host", "sh", "-c", "if command -v bash >/dev/null; then exec bash -l; else exec sh -l; fi"},
	}
	// Tracked before it exists, so the sweep on connect never takes a shell
	// that is starting for an orphan.
	key := req.Cluster + "/" + shell.Namespace + "/" + shell.Pod
	m.shells.track(key, shell)
	created, err := c.client.CoreV1().Pods(req.Namespace).Create(ctx, pod, metav1.CreateOptions{FieldManager: "clustrail"})
	if err != nil {
		m.shells.untrack(key)
		return NodeShell{}, err
	}
	m.shells.setUID(key, created.UID)
	if err := waitRunning(ctx, c, shell.Namespace, shell.Pod, "shell", false); err != nil {
		_ = m.DeleteNodeShell(req.Cluster, shell.Namespace, shell.Pod)
		return NodeShell{}, err
	}
	return shell, nil
}

func nodeShellPod(req NodeShellRequest, install string) *corev1.Pod {
	node := strings.ToLower(req.Node)
	if len(node) > 30 {
		node = node[:30]
	}
	yes := true
	var grace int64
	lifetime := int64(nodeShellLifetime / time.Second)
	labels := map[string]string{nodeShellLabel: "true", "app.kubernetes.io/managed-by": "clustrail"}
	if install != "" {
		labels[installLabel] = install
	}
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      strings.Trim("clustrail-node-shell-"+strings.ReplaceAll(node, ".", "-"), "-") + "-" + randomSuffix(5),
			Namespace: req.Namespace,
			Labels:    labels,
		},
		Spec: corev1.PodSpec{
			ActiveDeadlineSeconds:         &lifetime,
			NodeName:                      req.Node,
			HostPID:                       true,
			HostNetwork:                   true,
			HostIPC:                       true,
			RestartPolicy:                 corev1.RestartPolicyNever,
			TerminationGracePeriodSeconds: &grace,
			Tolerations:                   []corev1.Toleration{{Operator: corev1.TolerationOpExists}},
			Containers: []corev1.Container{{
				Name:            "shell",
				Image:           req.Image,
				Command:         []string{"sh", "-c", fmt.Sprintf("sleep %d", lifetime)},
				Stdin:           true,
				TTY:             true,
				SecurityContext: &corev1.SecurityContext{Privileged: &yes},
				VolumeMounts:    []corev1.VolumeMount{{Name: "host", MountPath: "/host"}},
			}},
			Volumes: []corev1.Volume{{Name: "host", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: "/"}}}},
		},
	}
}

// DeleteNodeShell deletes a node shell pod Clustrail started. The pod stays
// tracked until it is confirmed gone, so a failed delete (or a pod held by a
// finalizer) is retried at quit and found again on the next connect instead
// of leaving a privileged pod behind.
func (m *Manager) DeleteNodeShell(cluster, ns, pod string) error {
	key := cluster + "/" + ns + "/" + pod
	m.shells.mu.Lock()
	_, ok := m.shells.pods[key]
	uid := m.shells.uids[key]
	m.shells.mu.Unlock()
	if !ok {
		return fmt.Errorf("%s/%s is not a node shell Clustrail started", ns, pod)
	}
	c, err := m.conn(cluster)
	if err != nil {
		return fmt.Errorf("node shell pod %s/%s not deleted: %w", ns, pod, err)
	}
	ctx, cancel := actionCtx()
	defer cancel()
	if err := deleteNodeShellPod(ctx, c, ns, pod, uid); err != nil {
		return fmt.Errorf("node shell pod %s/%s not deleted: %w", ns, pod, err)
	}
	m.shells.untrack(key)
	return nil
}

// deleteNodeShellPod deletes the pod (only the one with this UID, when known)
// and waits briefly until it is gone. A pod with another UID is not ours.
func deleteNodeShellPod(ctx context.Context, c *clusterConn, ns, pod string, uid types.UID) error {
	var grace int64
	opts := metav1.DeleteOptions{GracePeriodSeconds: &grace}
	if uid != "" {
		opts.Preconditions = &metav1.Preconditions{UID: &uid}
	}
	err := c.client.CoreV1().Pods(ns).Delete(ctx, pod, opts)
	switch {
	case apierrors.IsNotFound(err), uid != "" && apierrors.IsConflict(err):
		return nil
	case err != nil:
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, nodeShellGoneWait)
	defer cancel()
	for {
		p, err := c.client.CoreV1().Pods(ns).Get(ctx, pod, metav1.GetOptions{})
		switch {
		case apierrors.IsNotFound(err), err == nil && uid != "" && p.UID != uid:
			return nil
		case err == nil && len(p.Finalizers) > 0:
			return fmt.Errorf("deletion accepted but held by finalizers %s", strings.Join(p.Finalizers, ", "))
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("deletion accepted but the pod is still there")
		case <-time.After(nodeShellGonePoll):
		}
	}
}

// A deleted node shell is checked every nodeShellGonePoll for being gone, for
// at most nodeShellGoneWait; quitting must not hang on a stuck pod.
var (
	nodeShellGonePoll = 200 * time.Millisecond
	nodeShellGoneWait = 5 * time.Second
)

// sweepNodeShells deletes this installation's node shell pods that no open
// shell uses: left behind by a crash, or by quitting while the cluster was
// unreachable. Pods of other installations are never touched.
func (m *Manager) sweepNodeShells(cluster string, c *clusterConn) {
	install := m.store.InstallID()
	if install == "" {
		return
	}
	ctx, cancel := actionCtx()
	defer cancel()
	sel := nodeShellLabel + "=true," + installLabel + "=" + install
	list, err := c.client.CoreV1().Pods("").List(ctx, metav1.ListOptions{LabelSelector: sel})
	if apierrors.IsForbidden(err) {
		list, err = c.client.CoreV1().Pods("kube-system").List(ctx, metav1.ListOptions{LabelSelector: sel})
	}
	if err != nil {
		slog.Warn("node shell sweep: listing failed", "cluster", cluster, "error", err)
		return
	}
	for i := range list.Items {
		p := &list.Items[i]
		key := cluster + "/" + p.Namespace + "/" + p.Name
		m.shells.mu.Lock()
		_, open := m.shells.pods[key]
		m.shells.mu.Unlock()
		if open {
			continue
		}
		if err := deleteNodeShellPod(ctx, c, p.Namespace, p.Name, p.UID); err != nil {
			slog.Error("node shell pod left running: delete it by hand", "cluster", cluster, "pod", p.Namespace+"/"+p.Name, "error", err,
				"command", fmt.Sprintf("kubectl --context %s -n %s delete pod %s", cluster, p.Namespace, p.Name))
			continue
		}
		slog.Info("deleted a node shell pod left behind", "cluster", cluster, "pod", p.Namespace+"/"+p.Name)
	}
}

// nodeShellRetry is the pause between attempts to delete node shells at quit.
var nodeShellRetry = time.Second

// CleanupNodeShells deletes every node shell pod still running, at quit,
// trying three times; pods it could not delete are logged with the command
// that removes them.
func (m *Manager) CleanupNodeShells() {
	for attempt := 0; attempt < 3; attempt++ {
		m.shells.mu.Lock()
		keys := make([]string, 0, len(m.shells.pods))
		for k := range m.shells.pods {
			keys = append(keys, k)
		}
		m.shells.mu.Unlock()
		if len(keys) == 0 {
			return
		}
		if attempt > 0 {
			time.Sleep(nodeShellRetry)
		}
		for _, k := range keys {
			parts := strings.SplitN(k, "/", 3)
			if len(parts) == 3 {
				_ = m.DeleteNodeShell(parts[0], parts[1], parts[2])
			}
		}
	}
	m.shells.mu.Lock()
	defer m.shells.mu.Unlock()
	for k := range m.shells.pods {
		parts := strings.SplitN(k, "/", 3)
		slog.Error("node shell pod left running: delete it by hand", "cluster", parts[0], "pod", parts[1]+"/"+parts[2],
			"command", fmt.Sprintf("kubectl --context %s -n %s delete pod %s", parts[0], parts[1], parts[2]))
	}
}
