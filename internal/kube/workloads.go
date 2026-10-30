package kube

import (
	"fmt"
	"math/rand/v2"
	"sort"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// Actions on StatefulSets, DaemonSets, Jobs and CronJobs. Kinds use the keys
// the generic lists use: "apps/StatefulSet", "apps/DaemonSet".

// RestartWorkload does what `kubectl rollout restart` does for a Deployment,
// StatefulSet or DaemonSet: it stamps the pod template.
func (m *Manager) RestartWorkload(cluster, kind, ns, name string) error {
	c, err := m.writable(cluster)
	if err != nil {
		return err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	patch := []byte(fmt.Sprintf(`{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":%q}}}}}`, time.Now().Format(time.RFC3339)))
	apps := c.client.AppsV1()
	switch kind {
	case "apps/Deployment", "Deployment":
		_, err = apps.Deployments(ns).Patch(ctx, name, types.StrategicMergePatchType, patch, fieldManager)
	case "apps/StatefulSet":
		_, err = apps.StatefulSets(ns).Patch(ctx, name, types.StrategicMergePatchType, patch, fieldManager)
	case "apps/DaemonSet":
		_, err = apps.DaemonSets(ns).Patch(ctx, name, types.StrategicMergePatchType, patch, fieldManager)
	default:
		return fmt.Errorf("%s cannot be restarted", kindLabel(kind))
	}
	return err
}

// ScaleWorkload sets replicas through the scale subresource, like `kubectl scale`.
func (m *Manager) ScaleWorkload(cluster, kind, ns, name string, replicas int32) error {
	if replicas < 0 {
		return fmt.Errorf("replicas must be 0 or more")
	}
	c, err := m.writable(cluster)
	if err != nil {
		return err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	apps := c.client.AppsV1()
	switch kind {
	case "apps/Deployment", "Deployment":
		s, err := apps.Deployments(ns).GetScale(ctx, name, metav1.GetOptions{})
		if err != nil {
			return err
		}
		s.Spec.Replicas = replicas
		_, err = apps.Deployments(ns).UpdateScale(ctx, name, s, metav1.UpdateOptions{FieldManager: "clustrail"})
		return err
	case "apps/StatefulSet":
		s, err := apps.StatefulSets(ns).GetScale(ctx, name, metav1.GetOptions{})
		if err != nil {
			return err
		}
		s.Spec.Replicas = replicas
		_, err = apps.StatefulSets(ns).UpdateScale(ctx, name, s, metav1.UpdateOptions{FieldManager: "clustrail"})
		return err
	}
	return fmt.Errorf("%s cannot be scaled", kindLabel(kind))
}

// WorkloadReplicas reads the desired replicas of a scalable workload, for the scale dialog.
func (m *Manager) WorkloadReplicas(cluster, kind, ns, name string) (int32, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return 0, err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	switch kind {
	case "apps/Deployment", "Deployment":
		s, err := c.client.AppsV1().Deployments(ns).GetScale(ctx, name, metav1.GetOptions{})
		if err != nil {
			return 0, err
		}
		return s.Spec.Replicas, nil
	case "apps/StatefulSet":
		s, err := c.client.AppsV1().StatefulSets(ns).GetScale(ctx, name, metav1.GetOptions{})
		if err != nil {
			return 0, err
		}
		return s.Spec.Replicas, nil
	}
	return 0, fmt.Errorf("%s cannot be scaled", kindLabel(kind))
}

// TriggerCronJob does what `kubectl create job --from=cronjob/NAME` does: a
// Job from the CronJob's template, owned by the CronJob and marked as started
// by hand. It returns the Job's name.
func (m *Manager) TriggerCronJob(cluster, ns, name string) (string, error) {
	c, err := m.writable(cluster)
	if err != nil {
		return "", err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	cj, err := c.client.BatchV1().CronJobs(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	job := manualJob(cj, time.Now())
	created, err := c.client.BatchV1().Jobs(ns).Create(ctx, job, metav1.CreateOptions{FieldManager: "clustrail"})
	if err != nil {
		return "", err
	}
	return created.Name, nil
}

func manualJob(cj *batchv1.CronJob, now time.Time) *batchv1.Job {
	// Job names are at most 63 characters: 44 + "-manual-" + 11. The suffix keeps two runs in the same minute apart.
	base := cj.Name
	if len(base) > 44 {
		base = base[:44]
	}
	suffix := fmt.Sprintf("%s%03d", now.Format("0102150405")[:8], rand.IntN(1000))
	annotations := map[string]string{"cronjob.kubernetes.io/instantiate": "manual"}
	for k, v := range cj.Spec.JobTemplate.Annotations {
		annotations[k] = v
	}
	labels := map[string]string{}
	for k, v := range cj.Spec.JobTemplate.Labels {
		labels[k] = v
	}
	yes := true
	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:        strings.TrimRight(base, "-") + "-manual-" + suffix,
			Namespace:   cj.Namespace,
			Annotations: annotations,
			Labels:      labels,
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: "batch/v1", Kind: "CronJob", Name: cj.Name, UID: cj.UID, Controller: &yes, BlockOwnerDeletion: &yes,
			}},
		},
		Spec: *cj.Spec.JobTemplate.Spec.DeepCopy(),
	}
}

func (m *Manager) SetCronJobSuspended(cluster, ns, name string, suspended bool) error {
	c, err := m.writable(cluster)
	if err != nil {
		return err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	_, err = c.client.BatchV1().CronJobs(ns).Patch(ctx, name, types.MergePatchType, []byte(fmt.Sprintf(`{"spec":{"suspend":%t}}`, suspended)), fieldManager)
	return err
}

// JobAttempt is one pod a Job ran: each retry after a failure is a new pod.
type JobAttempt struct {
	Pod      string `json:"pod"`
	Phase    string `json:"phase"`
	Health   Health `json:"health"`
	Reason   string `json:"reason,omitempty"`
	ExitCode *int32 `json:"exitCode,omitempty"`
	Started  string `json:"started,omitempty"`
	Duration string `json:"duration,omitempty"`
	Node     string `json:"node,omitempty"`
}

// JobStatus summarises a Job: its attempts, newest first, and why it ended.
type JobStatus struct {
	Succeeded    int32        `json:"succeeded"`
	Failed       int32        `json:"failed"`
	Active       int32        `json:"active"`
	Completions  int32        `json:"completions"`
	BackoffLimit int32        `json:"backoffLimit"`
	Condition    string       `json:"condition,omitempty"`
	Reason       string       `json:"reason,omitempty"`
	Message      string       `json:"message,omitempty"`
	Attempts     []JobAttempt `json:"attempts"`
	// Pods that no longer exist (deleted by TTL or backoff) are only counted.
	Missing int32 `json:"missing"`
}

func (m *Manager) JobStatus(cluster, ns, name string) (JobStatus, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return JobStatus{}, err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	job, err := c.client.BatchV1().Jobs(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return JobStatus{}, err
	}
	out := JobStatus{Succeeded: job.Status.Succeeded, Failed: job.Status.Failed, Active: job.Status.Active, Completions: 1, BackoffLimit: 6, Attempts: []JobAttempt{}}
	if job.Spec.Completions != nil {
		out.Completions = *job.Spec.Completions
	}
	if job.Spec.BackoffLimit != nil {
		out.BackoffLimit = *job.Spec.BackoffLimit
	}
	for _, cond := range job.Status.Conditions {
		if cond.Status == corev1.ConditionTrue && (cond.Type == batchv1.JobComplete || cond.Type == batchv1.JobFailed || cond.Type == batchv1.JobSuspended) {
			out.Condition, out.Reason, out.Message = string(cond.Type), cond.Reason, cond.Message
		}
	}
	if job.Spec.Selector == nil {
		return out, nil
	}
	sel, err := metav1.LabelSelectorAsSelector(job.Spec.Selector)
	if err != nil {
		return out, nil
	}
	pods, err := c.client.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{LabelSelector: sel.String()})
	if err != nil {
		return out, err
	}
	out.Attempts = jobAttempts(pods.Items, time.Now())
	if n := out.Succeeded + out.Failed + out.Active - int32(len(out.Attempts)); n > 0 {
		out.Missing = n
	}
	return out, nil
}

func jobAttempts(pods []corev1.Pod, now time.Time) []JobAttempt {
	sort.Slice(pods, func(i, j int) bool { return pods[i].CreationTimestamp.After(pods[j].CreationTimestamp.Time) })
	out := make([]JobAttempt, 0, len(pods))
	for i := range pods {
		p := &pods[i]
		a := JobAttempt{Pod: p.Name, Phase: string(p.Status.Phase), Node: p.Spec.NodeName}
		switch p.Status.Phase {
		case corev1.PodSucceeded:
			a.Health = Completed
		case corev1.PodFailed:
			a.Health = Failed
		case corev1.PodRunning:
			a.Health = Progressing
		case corev1.PodPending:
			a.Health = Progressing
		default:
			a.Health = Unknown
		}
		var start, end time.Time
		if p.Status.StartTime != nil {
			start = p.Status.StartTime.Time
		}
		for _, cs := range p.Status.ContainerStatuses {
			if t := cs.State.Terminated; t != nil {
				if a.ExitCode == nil || t.ExitCode != 0 {
					code := t.ExitCode
					a.ExitCode = &code
					a.Reason = t.Reason
				}
				if t.FinishedAt.After(end) {
					end = t.FinishedAt.Time
				}
			} else if w := cs.State.Waiting; w != nil && a.Reason == "" {
				a.Reason = w.Reason
			}
		}
		if a.Reason == "" {
			a.Reason = p.Status.Reason
		}
		if !start.IsZero() {
			a.Started = start.UTC().Format(time.RFC3339)
			if end.IsZero() {
				end = now
			}
			a.Duration = ago(end.Sub(start))
		}
		out = append(out, a)
	}
	return out
}

func kindLabel(kind string) string {
	return kind[strings.LastIndex(kind, "/")+1:]
}
