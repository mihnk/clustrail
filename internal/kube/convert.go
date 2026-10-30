package kube

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Usage is the latest metrics-server sample for one pod or node.
type Usage struct {
	CPUMilli  int
	MemoryMiB int
}

func ptr[T any](v T) *T { return &v }

func ageSeconds(t metav1.Time, now time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return int64(now.Sub(t.Time).Seconds())
}

// PodStatus classifies a pod the way the explorer shows it: one short status,
// the full reason, and a health category. It follows kubectl's printer.
func PodStatus(p *corev1.Pod, now time.Time) (Health, string, string) {
	if p.DeletionTimestamp != nil {
		return Terminating, "Terminating", "Terminating"
	}
	switch p.Status.Phase {
	case corev1.PodSucceeded:
		return Completed, "Completed", "Completed"
	case corev1.PodFailed:
		reason := p.Status.Reason
		if reason == "" {
			reason = "Error"
		}
		for _, cs := range p.Status.ContainerStatuses {
			if t := cs.State.Terminated; t != nil && t.ExitCode != 0 {
				return Failed, shortReason(t.Reason, "Error"), fmt.Sprintf("%s (exit %d)", orDefault(t.Reason, "Error"), t.ExitCode)
			}
		}
		return Failed, shortReason(reason, "Failed"), reason
	}

	// Init containers that fail block the pod.
	for _, cs := range p.Status.InitContainerStatuses {
		if w := cs.State.Waiting; w != nil && isFailingWaitReason(w.Reason) {
			return Failed, "Init:" + shortReason(w.Reason, w.Reason), "Init container " + cs.Name + ": " + w.Reason
		}
		if t := cs.State.Terminated; t != nil && t.ExitCode != 0 {
			return Failed, "Init:Error", fmt.Sprintf("Init container %s exited %d", cs.Name, t.ExitCode)
		}
	}
	for _, cs := range p.Status.ContainerStatuses {
		if w := cs.State.Waiting; w != nil && isFailingWaitReason(w.Reason) {
			reason := w.Reason
			if lt := cs.LastTerminationState.Terminated; lt != nil && lt.Reason != "" {
				reason = fmt.Sprintf("%s · last: %s (exit %d)", w.Reason, lt.Reason, lt.ExitCode)
			}
			return Failed, shortReason(w.Reason, w.Reason), reason
		}
	}
	if p.Status.Phase == corev1.PodPending {
		for _, c := range p.Status.Conditions {
			if c.Type == corev1.PodScheduled && c.Status == corev1.ConditionFalse {
				return Progressing, "Pending", strings.TrimSpace(c.Reason + ": " + c.Message)
			}
		}
		for _, cs := range p.Status.ContainerStatuses {
			if w := cs.State.Waiting; w != nil && w.Reason != "" {
				return Progressing, shortReason(w.Reason, "Pending"), w.Reason
			}
		}
		return Progressing, "Pending", "Pending"
	}

	ready, total := readyCounts(p)
	restartsRecent := 0
	for _, cs := range p.Status.ContainerStatuses {
		if lt := cs.LastTerminationState.Terminated; lt != nil && now.Sub(lt.FinishedAt.Time) < time.Hour {
			restartsRecent += int(cs.RestartCount)
		}
	}
	if ready < total {
		if restartsRecent > 0 {
			return Warning, "Restarting", fmt.Sprintf("Running, %d/%d ready, restarted within the last hour", ready, total)
		}
		return Warning, "NotReady", fmt.Sprintf("Running, %d/%d containers ready", ready, total)
	}
	if restartsRecent >= 3 {
		return Warning, "Restarting", fmt.Sprintf("Running, %d restarts in the last hour", restartsRecent)
	}
	return Healthy, "Running", "Running"
}

func isFailingWaitReason(r string) bool {
	switch r {
	case "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "InvalidImageName", "CreateContainerConfigError",
		"CreateContainerError", "RunContainerError", "ErrImageNeverPull", "PreStartHookError", "PostStartHookError":
		return true
	}
	return false
}

func shortReason(r, fallback string) string {
	switch r {
	case "":
		return fallback
	case "CrashLoopBackOff":
		return "CrashLoop"
	case "ImagePullBackOff", "ErrImagePull", "ErrImageNeverPull", "InvalidImageName":
		return "ImagePull"
	case "CreateContainerConfigError", "CreateContainerError":
		return "ConfigError"
	case "ContainerCreating", "PodInitializing":
		return "Creating"
	}
	return r
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

func readyCounts(p *corev1.Pod) (ready, total int) {
	total = len(p.Spec.Containers)
	for _, cs := range p.Status.ContainerStatuses {
		if cs.Ready {
			ready++
		}
	}
	return
}

// PodOwner resolves the controller: a ReplicaSet owned by a Deployment is shown as the Deployment.
func PodOwner(p *corev1.Pod, rsOwner func(ns, name string) *OwnerRef) *OwnerRef {
	ref := metav1.GetControllerOf(p)
	if ref == nil {
		return nil
	}
	if ref.Kind == "ReplicaSet" && rsOwner != nil {
		if o := rsOwner(p.Namespace, ref.Name); o != nil {
			return o
		}
	}
	if ref.Kind == "Job" && rsOwner != nil {
		if o := rsOwner(p.Namespace, "job/"+ref.Name); o != nil {
			return o
		}
	}
	return &OwnerRef{Kind: ref.Kind, Name: ref.Name}
}

func ToPodRow(p *corev1.Pod, cluster string, env Environment, usage *Usage, owner *OwnerRef, now time.Time) PodRow {
	h, st, reason := PodStatus(p, now)
	ready, total := readyCounts(p)
	restarts := 0
	for _, cs := range p.Status.ContainerStatuses {
		restarts += int(cs.RestartCount)
	}
	row := PodRow{
		ID:              cluster + "/" + p.Namespace + "/" + p.Name,
		UID:             string(p.UID),
		Name:            p.Name,
		Namespace:       p.Namespace,
		Cluster:         cluster,
		Env:             env,
		Node:            p.Spec.NodeName,
		Health:          h,
		Status:          st,
		Reason:          reason,
		ReadyContainers: ready,
		TotalContainers: total,
		Restarts:        restarts,
		AgeSeconds:      ageSeconds(p.CreationTimestamp, now),
		Owner:           owner,
		Labels:          p.Labels,
	}
	if row.Labels == nil {
		row.Labels = map[string]string{}
	}
	if usage != nil {
		row.CPUMilli = ptr(usage.CPUMilli)
		row.MemoryMiB = ptr(usage.MemoryMiB)
	}
	return row
}

// imageTag returns the tag (or short digest) of an image reference.
func imageTag(image string) string {
	if i := strings.LastIndex(image, "@sha256:"); i >= 0 {
		return "@" + image[i+8:min(len(image), i+8+12)]
	}
	slash := strings.LastIndex(image, "/")
	if i := strings.LastIndex(image, ":"); i > slash {
		return image[i+1:]
	}
	return "latest"
}

func revisionOf(o metav1.Object) int64 {
	v, _ := strconv.ParseInt(o.GetAnnotations()["deployment.kubernetes.io/revision"], 10, 64)
	return v
}

func condition(d *appsv1.Deployment, t appsv1.DeploymentConditionType) *appsv1.DeploymentCondition {
	for i := range d.Status.Conditions {
		if d.Status.Conditions[i].Type == t {
			return &d.Status.Conditions[i]
		}
	}
	return nil
}

// DeploymentState mirrors `kubectl rollout status` plus availability.
func DeploymentState(d *appsv1.Deployment, now time.Time) (h Health, status, rollout, reason, since string) {
	replicas := int32(1)
	if d.Spec.Replicas != nil {
		replicas = *d.Spec.Replicas
	}
	s := d.Status
	prog := condition(d, appsv1.DeploymentProgressing)
	avail := condition(d, appsv1.DeploymentAvailable)
	sinceOf := func(c *appsv1.DeploymentCondition) string {
		if c == nil || c.LastTransitionTime.IsZero() {
			return ""
		}
		return ago(now.Sub(c.LastTransitionTime.Time))
	}
	switch {
	case d.Spec.Paused:
		return Paused, "Available", "Paused", "spec.paused=true", ""
	case prog != nil && prog.Reason == "ProgressDeadlineExceeded":
		return Failed, "Degraded", "Stalled", "Progressing=False: ProgressDeadlineExceeded", sinceOf(prog)
	// A rollout is in progress while the controller has not caught up, new pods are missing, old
	// pods remain, or the Progressing condition still reports ReplicaSetUpdated. Unavailable pods
	// after a finished rollout are a degraded Deployment, not a rollout.
	case d.Generation > s.ObservedGeneration || s.UpdatedReplicas < replicas || s.Replicas > s.UpdatedReplicas || (prog != nil && prog.Reason == "ReplicaSetUpdated"):
		if avail != nil && avail.Status == corev1.ConditionFalse {
			return Failed, "Degraded", "Progressing", fmt.Sprintf("Rolling out: %d of %d updated · Available=False", s.UpdatedReplicas, replicas), sinceOf(avail)
		}
		return Progressing, "Progressing", "Progressing", fmt.Sprintf("Rolling out: %d of %d updated", s.UpdatedReplicas, replicas), ""
	case avail != nil && avail.Status == corev1.ConditionFalse:
		return Failed, "Degraded", "Degraded", "Available=False: " + avail.Reason, sinceOf(avail)
	case s.ReadyReplicas < replicas:
		return Warning, "Available", "Complete", fmt.Sprintf("%d of %d replicas ready", s.ReadyReplicas, replicas), ""
	case replicas == 0:
		return Idle, "Available", "Complete", "Scaled to 0", ""
	}
	return Healthy, "Available", "Complete", "Available, rollout complete", ""
}

// ToDeploymentRow builds the explorer row. rsets are the ReplicaSets owned by
// the Deployment (rollout history); hpa targets it if non-nil; usage sums the
// metrics of its pods.
func ToDeploymentRow(d *appsv1.Deployment, cluster string, env Environment, rsets []*appsv1.ReplicaSet, hpa *autoscalingv2.HorizontalPodAutoscaler, usage *DeploymentUsage, now time.Time) DeploymentRow {
	h, status, rollout, reason, since := DeploymentState(d, now)
	replicas := int32(1)
	if d.Spec.Replicas != nil {
		replicas = *d.Spec.Replicas
	}
	image := ""
	if cs := d.Spec.Template.Spec.Containers; len(cs) > 0 {
		image = imageTag(cs[0].Image)
	}
	row := DeploymentRow{
		ID:                cluster + "/" + d.Namespace + "/" + d.Name,
		UID:               string(d.UID),
		Name:              d.Name,
		Namespace:         d.Namespace,
		Cluster:           cluster,
		Env:               env,
		Health:            h,
		Status:            status,
		Rollout:           rollout,
		Reason:            reason,
		Since:             since,
		Image:             image,
		ReadyReplicas:     d.Status.ReadyReplicas,
		Replicas:          replicas,
		UpdatedReplicas:   d.Status.UpdatedReplicas,
		AvailableReplicas: d.Status.AvailableReplicas,
		AgeSeconds:        ageSeconds(d.CreationTimestamp, now),
		Usage:             usage,
		Revisions:         []Revision{},
	}
	if d.Spec.Strategy.Type == appsv1.RecreateDeploymentStrategyType {
		row.Strategy = Strategy{Type: "Recreate"}
	} else {
		row.Strategy = Strategy{Type: "RollingUpdate", MaxSurge: "25%", MaxUnavailable: "25%"}
		if ru := d.Spec.Strategy.RollingUpdate; ru != nil {
			if ru.MaxSurge != nil {
				row.Strategy.MaxSurge = ru.MaxSurge.String()
			}
			if ru.MaxUnavailable != nil {
				row.Strategy.MaxUnavailable = ru.MaxUnavailable.String()
			}
		}
	}
	if hpa != nil {
		row.HPA = &HPARef{Name: hpa.Name, Max: hpa.Spec.MaxReplicas, Min: 1}
		if hpa.Spec.MinReplicas != nil {
			row.HPA.Min = *hpa.Spec.MinReplicas
		}
	}
	if id := d.Annotations["argocd.argoproj.io/tracking-id"]; id != "" {
		row.ArgoApp = strings.SplitN(id, ":", 2)[0]
	} else if inst := d.Labels["argocd.argoproj.io/instance"]; inst != "" {
		row.ArgoApp = inst
	}
	sort.Slice(rsets, func(i, j int) bool { return revisionOf(rsets[i]) > revisionOf(rsets[j]) })
	for _, rs := range rsets {
		rev := revisionOf(rs)
		if rev == 0 {
			continue
		}
		img := ""
		if cs := rs.Spec.Template.Spec.Containers; len(cs) > 0 {
			img = imageTag(cs[0].Image)
		}
		row.Revisions = append(row.Revisions, Revision{Rev: rev, Image: img, Age: ago(now.Sub(rs.CreationTimestamp.Time))})
	}
	return row
}

func quantityMilli(q resource.Quantity) float64 { return float64(q.MilliValue()) }

// PodRequests sums container requests and limits (init containers by max, as the scheduler does).
func PodRequests(p *corev1.Pod) (cpuReq, cpuLim, memReq, memLim float64) {
	for _, c := range p.Spec.Containers {
		cpuReq += quantityMilli(c.Resources.Requests[corev1.ResourceCPU])
		cpuLim += quantityMilli(c.Resources.Limits[corev1.ResourceCPU])
		memReq += float64(c.Resources.Requests.Memory().Value())
		memLim += float64(c.Resources.Limits.Memory().Value())
	}
	for _, c := range p.Spec.InitContainers {
		cpuReq = max(cpuReq, quantityMilli(c.Resources.Requests[corev1.ResourceCPU]))
		memReq = max(memReq, float64(c.Resources.Requests.Memory().Value()))
	}
	return
}

const gib = 1024 * 1024 * 1024

var conditionOK = map[string]corev1.ConditionStatus{
	"Ready":              corev1.ConditionTrue,
	"MemoryPressure":     corev1.ConditionFalse,
	"DiskPressure":       corev1.ConditionFalse,
	"PIDPressure":        corev1.ConditionFalse,
	"NetworkUnavailable": corev1.ConditionFalse,
}

// ToNodeRow builds the node row. pods are the non-terminated pods bound to it.
func ToNodeRow(n *corev1.Node, cluster string, env Environment, pods []*corev1.Pod, usage *Usage, now time.Time) NodeRow {
	row := NodeRow{
		ID:           cluster + "/" + n.Name,
		Name:         n.Name,
		Cluster:      cluster,
		Env:          env,
		GitVersion:   n.Status.NodeInfo.KubeletVersion,
		Version:      shortVersion(n.Status.NodeInfo.KubeletVersion),
		InstanceType: orDefault(n.Labels["node.kubernetes.io/instance-type"], n.Labels["beta.kubernetes.io/instance-type"]),
		Zone:         n.Labels["topology.kubernetes.io/zone"],
		Labels:       n.Labels,
		AgeSeconds:   ageSeconds(n.CreationTimestamp, now),
		PodCapacity:  n.Status.Allocatable.Pods().Value(),
		Taints:       []Taint{},
		Conditions:   []NodeCondition{},
	}
	var roles []string
	for k := range n.Labels {
		if r, ok := strings.CutPrefix(k, "node-role.kubernetes.io/"); ok && r != "" {
			roles = append(roles, r)
		}
	}
	if _, ok := n.Labels["nvidia.com/gpu.present"]; ok || !n.Status.Allocatable.Name("nvidia.com/gpu", resource.DecimalSI).IsZero() {
		roles = append(roles, "gpu")
	}
	if len(roles) == 0 {
		roles = []string{"worker"}
	}
	sort.Strings(roles)
	row.Roles = strings.Join(roles, ",")

	for _, t := range n.Spec.Taints {
		row.Taints = append(row.Taints, Taint{Key: t.Key, Value: t.Value, Effect: string(t.Effect)})
	}
	ready := corev1.ConditionUnknown
	var readyCond corev1.NodeCondition
	var pressure []string
	for _, c := range n.Status.Conditions {
		want, known := conditionOK[string(c.Type)]
		if !known {
			continue
		}
		row.Conditions = append(row.Conditions, NodeCondition{
			Type:   string(c.Type),
			Status: string(c.Status),
			Reason: c.Reason,
			Since:  ago(now.Sub(c.LastTransitionTime.Time)),
			OK:     c.Status == want,
		})
		if c.Type == corev1.NodeReady {
			ready, readyCond = c.Status, c
			row.Heartbeat = ago(now.Sub(c.LastHeartbeatTime.Time)) + " ago"
		} else if c.Status == corev1.ConditionTrue {
			pressure = append(pressure, string(c.Type))
		}
	}
	switch {
	case ready != corev1.ConditionTrue:
		row.Health, row.Status = Failed, "NotReady"
		row.Reason = orDefault(readyCond.Message, "Ready="+string(ready))
	case n.Spec.Unschedulable:
		row.Health, row.Status, row.Reason = Cordoned, "Cordoned", "Ready, SchedulingDisabled"
		for _, t := range n.Spec.Taints {
			if t.Key == corev1.TaintNodeUnschedulable && t.TimeAdded != nil {
				row.CordonedAgo = ago(now.Sub(t.TimeAdded.Time))
			}
		}
		row.CordonedBy = n.Annotations["clustrail.io/cordoned-by"]
	case len(pressure) > 0:
		row.Health, row.Status = Warning, map[string]string{"MemoryPressure": "MemPressure", "NetworkUnavailable": "NetUnavailable"}[pressure[0]]
		if row.Status == "" {
			row.Status = pressure[0]
		}
		row.Reason = strings.Join(pressure, ", ") + "=True"
	default:
		row.Health, row.Status, row.Reason = Healthy, "Ready", "Ready=True"
	}

	allocCPU := quantityMilli(n.Status.Allocatable[corev1.ResourceCPU]) / 1000
	allocMem := float64(n.Status.Allocatable.Memory().Value()) / gib
	row.CPU.Allocatable = round1(allocCPU)
	row.MemoryGiB.Allocatable = round1(allocMem)
	for _, p := range pods {
		if p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed {
			continue
		}
		row.Pods++
		cr, cl, mr, _ := PodRequests(p)
		row.CPU.Requests += cr / 1000
		row.CPU.Limits += cl / 1000
		row.MemoryGiB.Requests += mr / gib
	}
	row.CPU.Requests, row.CPU.Limits, row.MemoryGiB.Requests = round1(row.CPU.Requests), round1(row.CPU.Limits), round1(row.MemoryGiB.Requests)
	if usage != nil {
		cpu := float64(usage.CPUMilli) / 1000
		mem := float64(usage.MemoryMiB) / 1024
		row.CPU.Used, row.MemoryGiB.Used = ptr(round1(cpu)), ptr(round1(mem))
		if allocCPU > 0 {
			row.CPUPct = ptr(int(cpu / allocCPU * 100))
		}
		if allocMem > 0 {
			row.MemPct = ptr(int(mem / allocMem * 100))
		}
	}
	return row
}

func round1(v float64) float64 { return float64(int64(v*10+0.5)) / 10 }

// shortVersion turns "v1.30.4-eks-a737599" into "1.30".
func shortVersion(v string) string {
	v = strings.TrimPrefix(v, "v")
	parts := strings.SplitN(v, ".", 3)
	if len(parts) >= 2 {
		return parts[0] + "." + parts[1]
	}
	return v
}
