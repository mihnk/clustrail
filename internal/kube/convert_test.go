package kube

import (
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
)

var now = time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)

func pod(name string, mutate func(p *corev1.Pod)) *corev1.Pod {
	p := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "payments", CreationTimestamp: metav1.NewTime(now.Add(-3 * 24 * time.Hour)), Labels: map[string]string{"app": "checkout-api"}},
		Spec:       corev1.PodSpec{NodeName: "node-1", Containers: []corev1.Container{{Name: "api", Image: "ghcr.io/acme/checkout-api:v2.31.0"}, {Name: "envoy"}}},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{
				{Name: "api", Ready: true, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}},
				{Name: "envoy", Ready: true, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}},
			},
		},
	}
	if mutate != nil {
		mutate(p)
	}
	return p
}

func TestPodStatus(t *testing.T) {
	cases := []struct {
		name   string
		pod    *corev1.Pod
		health Health
		status string
	}{
		{"running", pod("ok", nil), Healthy, "Running"},
		{"crashloop", pod("crash", func(p *corev1.Pod) {
			p.Status.ContainerStatuses[0] = corev1.ContainerStatus{
				Name: "api", RestartCount: 14,
				State:                corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}},
				LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "OOMKilled", ExitCode: 137, FinishedAt: metav1.NewTime(now.Add(-2 * time.Minute))}},
			}
		}), Failed, "CrashLoop"},
		{"image pull", pod("pull", func(p *corev1.Pod) {
			p.Status.Phase = corev1.PodPending
			p.Status.ContainerStatuses[0].State = corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "ImagePullBackOff"}}
			p.Status.ContainerStatuses[0].Ready = false
		}), Failed, "ImagePull"},
		{"unschedulable", pod("pending", func(p *corev1.Pod) {
			p.Status.Phase = corev1.PodPending
			p.Status.ContainerStatuses = nil
			p.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: "Unschedulable", Message: "0/12 nodes are available"}}
		}), Progressing, "Pending"},
		{"completed", pod("done", func(p *corev1.Pod) { p.Status.Phase = corev1.PodSucceeded }), Completed, "Completed"},
		{"terminating", pod("term", func(p *corev1.Pod) { ts := metav1.NewTime(now); p.DeletionTimestamp = &ts }), Terminating, "Terminating"},
		{"not ready", pod("nr", func(p *corev1.Pod) { p.Status.ContainerStatuses[1].Ready = false }), Warning, "NotReady"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, st, reason := PodStatus(tc.pod, now)
			if h != tc.health || st != tc.status {
				t.Fatalf("got %s/%s (%s), want %s/%s", h, st, reason, tc.health, tc.status)
			}
		})
	}
}

func TestCrashLoopReasonNamesLastTermination(t *testing.T) {
	p := pod("crash", func(p *corev1.Pod) {
		p.Status.ContainerStatuses[0] = corev1.ContainerStatus{
			Name:                 "api",
			State:                corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}},
			LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "OOMKilled", ExitCode: 137}},
		}
	})
	_, _, reason := PodStatus(p, now)
	if reason != "CrashLoopBackOff · last: OOMKilled (exit 137)" {
		t.Fatalf("reason = %q", reason)
	}
}

func TestToPodRow(t *testing.T) {
	p := pod("checkout-api-7d9f8b6c4-x2kqp", func(p *corev1.Pod) {
		p.OwnerReferences = []metav1.OwnerReference{{Kind: "ReplicaSet", Name: "checkout-api-7d9f8b6c4", Controller: ptr(true)}}
		p.Status.ContainerStatuses[0].RestartCount = 3
	})
	row := ToPodRow(p, "prod-eu-west-1", EnvProd, &Usage{CPUMilli: 212, MemoryMiB: 251}, &OwnerRef{Kind: "Deployment", Name: "checkout-api"}, now)
	if row.ID != "prod-eu-west-1/payments/checkout-api-7d9f8b6c4-x2kqp" || row.ReadyContainers != 2 || row.TotalContainers != 2 || row.Restarts != 3 {
		t.Fatalf("row = %+v", row)
	}
	if row.CPUMilli == nil || *row.CPUMilli != 212 || row.AgeSeconds != 3*24*3600 {
		t.Fatalf("usage/age wrong: %+v", row)
	}
	noMetrics := ToPodRow(p, "c", EnvDev, nil, nil, now)
	if noMetrics.CPUMilli != nil || noMetrics.MemoryMiB != nil {
		t.Fatal("missing metrics must stay nil, never 0")
	}
}

func deployment(mutate func(d *appsv1.Deployment)) *appsv1.Deployment {
	d := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "checkout-api", Namespace: "payments", UID: types.UID("dep-uid"), Generation: 14, CreationTimestamp: metav1.NewTime(now.Add(-212 * 24 * time.Hour))},
		Spec: appsv1.DeploymentSpec{
			Replicas: ptr(int32(4)),
			Strategy: appsv1.DeploymentStrategy{Type: appsv1.RollingUpdateDeploymentStrategyType, RollingUpdate: &appsv1.RollingUpdateDeployment{MaxSurge: ptr(intstr.FromInt32(1)), MaxUnavailable: ptr(intstr.FromInt32(1))}},
			Template: corev1.PodTemplateSpec{Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "api", Image: "ghcr.io/acme/checkout-api:v2.31.0"}}}},
		},
		Status: appsv1.DeploymentStatus{ObservedGeneration: 14, Replicas: 4, UpdatedReplicas: 4, ReadyReplicas: 4, AvailableReplicas: 4},
	}
	if mutate != nil {
		mutate(d)
	}
	return d
}

func TestDeploymentState(t *testing.T) {
	cases := []struct {
		name    string
		d       *appsv1.Deployment
		health  Health
		rollout string
	}{
		{"complete", deployment(nil), Healthy, "Complete"},
		{"degraded", deployment(func(d *appsv1.Deployment) {
			d.Status.ReadyReplicas, d.Status.AvailableReplicas = 2, 2
			d.Status.Conditions = []appsv1.DeploymentCondition{{Type: appsv1.DeploymentAvailable, Status: corev1.ConditionFalse, Reason: "MinimumReplicasUnavailable", LastTransitionTime: metav1.NewTime(now.Add(-47 * time.Minute))}}
		}), Failed, "Degraded"},
		{"rolling out with unavailable pods", deployment(func(d *appsv1.Deployment) {
			d.Status.UpdatedReplicas, d.Status.AvailableReplicas = 2, 2
			d.Status.Conditions = []appsv1.DeploymentCondition{{Type: appsv1.DeploymentAvailable, Status: corev1.ConditionFalse, Reason: "MinimumReplicasUnavailable"}}
		}), Failed, "Progressing"},
		{"stalled", deployment(func(d *appsv1.Deployment) {
			d.Status.Conditions = []appsv1.DeploymentCondition{{Type: appsv1.DeploymentProgressing, Status: corev1.ConditionFalse, Reason: "ProgressDeadlineExceeded"}}
		}), Failed, "Stalled"},
		{"paused", deployment(func(d *appsv1.Deployment) { d.Spec.Paused = true }), Paused, "Paused"},
		{"progressing", deployment(func(d *appsv1.Deployment) { d.Status.UpdatedReplicas = 2 }), Progressing, "Progressing"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, _, rollout, reason, _ := DeploymentState(tc.d, now)
			if h != tc.health || rollout != tc.rollout {
				t.Fatalf("got %s/%s (%s), want %s/%s", h, rollout, reason, tc.health, tc.rollout)
			}
		})
	}
}

func TestToDeploymentRowRevisionsAndHPA(t *testing.T) {
	d := deployment(func(d *appsv1.Deployment) {
		d.Annotations = map[string]string{"argocd.argoproj.io/tracking-id": "checkout-api:apps/Deployment:payments/checkout-api"}
	})
	rs := func(rev, image string, age time.Duration) *appsv1.ReplicaSet {
		return &appsv1.ReplicaSet{
			ObjectMeta: metav1.ObjectMeta{Annotations: map[string]string{"deployment.kubernetes.io/revision": rev}, CreationTimestamp: metav1.NewTime(now.Add(-age))},
			Spec:       appsv1.ReplicaSetSpec{Template: corev1.PodTemplateSpec{Spec: corev1.PodSpec{Containers: []corev1.Container{{Image: "ghcr.io/acme/checkout-api:" + image}}}}},
		}
	}
	hpa := &autoscalingv2.HorizontalPodAutoscaler{ObjectMeta: metav1.ObjectMeta{Name: "checkout-api"}, Spec: autoscalingv2.HorizontalPodAutoscalerSpec{MinReplicas: ptr(int32(4)), MaxReplicas: 8}}
	row := ToDeploymentRow(d, "prod", EnvProd, []*appsv1.ReplicaSet{rs("13", "v2.30.4", 9*24*time.Hour), rs("14", "v2.31.0", 3*24*time.Hour)}, hpa, nil, now)
	if len(row.Revisions) != 2 || row.Revisions[0].Rev != 14 || row.Revisions[0].Image != "v2.31.0" || row.Revisions[1].Age != "9d" {
		t.Fatalf("revisions = %+v", row.Revisions)
	}
	if row.HPA == nil || row.HPA.Min != 4 || row.HPA.Max != 8 || row.ArgoApp != "checkout-api" || row.Image != "v2.31.0" {
		t.Fatalf("row = %+v", row)
	}
	if row.Strategy.MaxSurge != "1" || row.Strategy.MaxUnavailable != "1" {
		t.Fatalf("strategy = %+v", row.Strategy)
	}
}

func TestImageTag(t *testing.T) {
	for in, want := range map[string]string{
		"ghcr.io/acme/api:v1.2.3":              "v1.2.3",
		"localhost:5000/api":                   "latest",
		"nginx":                                "latest",
		"repo/app@sha256:0123456789abcdef0123": "@0123456789ab",
	} {
		if got := imageTag(in); got != want {
			t.Errorf("imageTag(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestToNodeRow(t *testing.T) {
	n := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Name: "ip-10-42-3-17.eu-west-1.compute.internal", Labels: map[string]string{
			"node.kubernetes.io/instance-type": "m6i.2xlarge", "topology.kubernetes.io/zone": "eu-west-1a",
		}},
		Spec: corev1.NodeSpec{Unschedulable: true, Taints: []corev1.Taint{{Key: corev1.TaintNodeUnschedulable, Effect: corev1.TaintEffectNoSchedule, TimeAdded: ptr(metav1.NewTime(now.Add(-18 * time.Minute)))}}},
		Status: corev1.NodeStatus{
			NodeInfo:    corev1.NodeSystemInfo{KubeletVersion: "v1.30.4-eks-a737599"},
			Allocatable: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("7910m"), corev1.ResourceMemory: resource.MustParse("28466Mi"), corev1.ResourcePods: resource.MustParse("58")},
			Conditions:  []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue, LastHeartbeatTime: metav1.NewTime(now.Add(-10 * time.Second))}},
		},
	}
	p := pod("a", func(p *corev1.Pod) {
		p.Spec.Containers[0].Resources = corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("500m"), corev1.ResourceMemory: resource.MustParse("1Gi")}}
	})
	row := ToNodeRow(n, "prod", EnvProd, []*corev1.Pod{p}, &Usage{CPUMilli: 3955, MemoryMiB: 14233}, now)
	if row.Health != Cordoned || row.CordonedAgo != "18m" || row.Version != "1.30" || row.Roles != "worker" {
		t.Fatalf("row = %+v", row)
	}
	if row.Pods != 1 || row.CPU.Requests != 0.5 || row.MemoryGiB.Requests != 1 || row.PodCapacity != 58 {
		t.Fatalf("requests = %+v %+v", row.CPU, row.MemoryGiB)
	}
	if row.CPUPct == nil || *row.CPUPct != 50 {
		t.Fatalf("cpuPct = %v", row.CPUPct)
	}
	if row.Zone != "eu-west-1a" || row.InstanceType != "m6i.2xlarge" {
		t.Fatalf("labels = %+v", row)
	}

	n.Spec.Unschedulable = false
	n.Status.Conditions = append(n.Status.Conditions, corev1.NodeCondition{Type: corev1.NodeMemoryPressure, Status: corev1.ConditionTrue})
	if row := ToNodeRow(n, "prod", EnvProd, nil, nil, now); row.Health != Warning || row.Status != "MemPressure" || row.CPUPct != nil {
		t.Fatalf("pressure row = %s %s %v", row.Health, row.Status, row.CPUPct)
	}
	n.Status.Conditions[0].Status = corev1.ConditionUnknown
	if row := ToNodeRow(n, "prod", EnvProd, nil, nil, now); row.Health != Failed || row.Status != "NotReady" {
		t.Fatalf("notready row = %s %s", row.Health, row.Status)
	}
}

func TestDisplayNameAndGuessEnv(t *testing.T) {
	for in, want := range map[string]string{
		"arn:aws:eks:eu-west-1:482100000000:cluster/prod-eu-west-1": "prod-eu-west-1",
		"gke_acme-staging_europe-west4_staging-eu-1":                "staging-eu-1",
		"kind-kind-local": "kind-kind-local",
	} {
		if got := DisplayName(in); got != want {
			t.Errorf("DisplayName(%q) = %q", in, got)
		}
	}
	if GuessEnv("prod-eu-west-1") != EnvProd || GuessEnv("staging-perf") != EnvStg || GuessEnv("kind-local") != EnvDev {
		t.Fatal("GuessEnv")
	}
}
