package kube

import (
	"context"
	"fmt"
	"math/rand/v2"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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

const nodeShellLabel = "clustrail.mihnk.org/node-shell"

type nodeShells struct {
	mu   sync.Mutex
	pods map[string]NodeShell // cluster/ns/pod
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
	pod := nodeShellPod(req)
	created, err := c.client.CoreV1().Pods(req.Namespace).Create(ctx, pod, metav1.CreateOptions{FieldManager: "clustrail"})
	if err != nil {
		return NodeShell{}, err
	}
	shell := NodeShell{
		Namespace: created.Namespace, Pod: created.Name, Container: "shell",
		Command: []string{"chroot", "/host", "sh", "-c", "if command -v bash >/dev/null; then exec bash -l; else exec sh -l; fi"},
	}
	m.shells.mu.Lock()
	if m.shells.pods == nil {
		m.shells.pods = map[string]NodeShell{}
	}
	m.shells.pods[req.Cluster+"/"+shell.Namespace+"/"+shell.Pod] = shell
	m.shells.mu.Unlock()
	if err := waitRunning(ctx, c, shell.Namespace, shell.Pod, "shell", false); err != nil {
		_ = m.DeleteNodeShell(req.Cluster, shell.Namespace, shell.Pod)
		return NodeShell{}, err
	}
	return shell, nil
}

func nodeShellPod(req NodeShellRequest) *corev1.Pod {
	node := strings.ToLower(req.Node)
	if len(node) > 30 {
		node = node[:30]
	}
	yes := true
	var grace int64
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      strings.Trim("clustrail-node-shell-"+strings.ReplaceAll(node, ".", "-"), "-") + "-" + randomSuffix(5),
			Namespace: req.Namespace,
			Labels:    map[string]string{nodeShellLabel: "true", "app.kubernetes.io/managed-by": "clustrail"},
		},
		Spec: corev1.PodSpec{
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
				Command:         []string{"sh", "-c", "sleep 86400"},
				Stdin:           true,
				TTY:             true,
				SecurityContext: &corev1.SecurityContext{Privileged: &yes},
				VolumeMounts:    []corev1.VolumeMount{{Name: "host", MountPath: "/host"}},
			}},
			Volumes: []corev1.Volume{{Name: "host", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: "/"}}}},
		},
	}
}

// DeleteNodeShell deletes a node shell pod Clustrail started.
func (m *Manager) DeleteNodeShell(cluster, ns, pod string) error {
	m.shells.mu.Lock()
	_, ok := m.shells.pods[cluster+"/"+ns+"/"+pod]
	delete(m.shells.pods, cluster+"/"+ns+"/"+pod)
	m.shells.mu.Unlock()
	if !ok {
		return fmt.Errorf("%s/%s is not a node shell Clustrail started", ns, pod)
	}
	c, err := m.conn(cluster)
	if err != nil {
		return err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	var grace int64
	err = c.client.CoreV1().Pods(ns).Delete(ctx, pod, metav1.DeleteOptions{GracePeriodSeconds: &grace})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

// CleanupNodeShells deletes every node shell pod still running, at quit.
func (m *Manager) CleanupNodeShells() {
	m.shells.mu.Lock()
	keys := make([]string, 0, len(m.shells.pods))
	for k := range m.shells.pods {
		keys = append(keys, k)
	}
	m.shells.mu.Unlock()
	for _, k := range keys {
		parts := strings.SplitN(k, "/", 3)
		if len(parts) == 3 {
			_ = m.DeleteNodeShell(parts[0], parts[1], parts[2])
		}
	}
}
