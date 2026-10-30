package kube

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/scheme"
)

// TestWriteUIFixture writes JSON produced by the real converters, used by the
// frontend's desktop-mode browser test. Run with CLUSTRAIL_FIXTURE=<path>.
func TestWriteUIFixture(t *testing.T) {
	out := os.Getenv("CLUSTRAIL_FIXTURE")
	if out == "" {
		t.Skip("set CLUSTRAIL_FIXTURE to write the UI fixture")
	}
	created := metav1.NewTime(time.Now().Add(-72 * time.Hour))
	dep := deployment(func(d *appsv1.Deployment) {
		d.CreationTimestamp = created
		d.Spec.Selector = &metav1.LabelSelector{MatchLabels: map[string]string{"app": "checkout-api"}}
		d.Spec.Replicas = ptr(int32(3))
		d.Status = appsv1.DeploymentStatus{ObservedGeneration: 14, Replicas: 3, UpdatedReplicas: 3, ReadyReplicas: 2, AvailableReplicas: 2,
			Conditions: []appsv1.DeploymentCondition{{Type: appsv1.DeploymentAvailable, Status: corev1.ConditionFalse, Reason: "MinimumReplicasUnavailable", LastTransitionTime: metav1.NewTime(time.Now().Add(-47 * time.Minute))}}}
		d.Spec.Template.Spec.Containers[0].Resources = corev1.ResourceRequirements{
			Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("250m"), corev1.ResourceMemory: resource.MustParse("192Mi")},
			Limits:   corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("256Mi")},
		}
	})
	dep.TypeMeta = metav1.TypeMeta{APIVersion: "apps/v1", Kind: "Deployment"}
	rs := &appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "checkout-api-7d9f8b6c4", Namespace: "payments", CreationTimestamp: created,
		Annotations:     map[string]string{"deployment.kubernetes.io/revision": "14"},
		OwnerReferences: []metav1.OwnerReference{{Kind: "Deployment", Name: "checkout-api", UID: dep.UID, Controller: ptr(true)}}},
		Spec: appsv1.ReplicaSetSpec{Template: dep.Spec.Template}}
	owned := func(p *corev1.Pod) {
		p.CreationTimestamp = created
		p.Spec.NodeName = "ip-10-42-3-17.eu-west-1.compute.internal"
		p.OwnerReferences = []metav1.OwnerReference{{Kind: "ReplicaSet", Name: rs.Name, Controller: ptr(true)}}
		p.Spec.Containers[0].Resources = dep.Spec.Template.Spec.Containers[0].Resources
	}
	crash := pod("checkout-api-7d9f8b6c4-x2kqp", func(p *corev1.Pod) {
		owned(p)
		p.Status.ContainerStatuses[0] = corev1.ContainerStatus{Name: "api", RestartCount: 14, Image: "ghcr.io/acme/checkout-api:v2.31.0",
			State:                corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}},
			LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "OOMKilled", ExitCode: 137, FinishedAt: metav1.NewTime(time.Now().Add(-2 * time.Minute))}}}
	})
	ok1 := pod("checkout-api-7d9f8b6c4-9rkzd", owned)
	ok2 := pod("checkout-api-7d9f8b6c4-h2pqs", owned)
	node := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Name: "ip-10-42-3-17.eu-west-1.compute.internal", CreationTimestamp: created, Labels: map[string]string{
			"node.kubernetes.io/instance-type": "m6i.2xlarge", "topology.kubernetes.io/zone": "eu-west-1a", "topology.kubernetes.io/region": "eu-west-1"}},
		Status: corev1.NodeStatus{
			NodeInfo:    corev1.NodeSystemInfo{KubeletVersion: "v1.30.4-eks-a737599"},
			Allocatable: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("7910m"), corev1.ResourceMemory: resource.MustParse("28466Mi"), corev1.ResourcePods: resource.MustParse("58")},
			Conditions:  []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue, LastHeartbeatTime: metav1.Now(), LastTransitionTime: created}},
		},
	}
	pdb := &policyv1.PodDisruptionBudget{ObjectMeta: metav1.ObjectMeta{Name: "checkout-api", Namespace: "payments"},
		Spec:   policyv1.PodDisruptionBudgetSpec{MinAvailable: ptr(intstr.FromInt32(3)), Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "checkout-api"}}},
		Status: policyv1.PodDisruptionBudgetStatus{DisruptionsAllowed: 0}}
	svc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "checkout-api", Namespace: "payments"}, Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "checkout-api"}}}
	ev := &corev1.Event{ObjectMeta: metav1.ObjectMeta{Name: "x2kqp.1", Namespace: "payments"}, InvolvedObject: corev1.ObjectReference{Kind: "Pod", Name: crash.Name, Namespace: "payments"},
		Type: "Warning", Reason: "BackOff", Message: "Back-off restarting failed container api", Count: 42, LastTimestamp: metav1.NewTime(time.Now().Add(-time.Minute))}

	c, client, _ := newFakeConn(t, dep, rs, crash, ok1, ok2, node, pdb, svc, ev)
	client.Fake.Resources = []*metav1.APIResourceList{{GroupVersion: "apps/v1", APIResources: []metav1.APIResource{{Name: "deployments", Kind: "Deployment", Namespaced: true}}}}
	raw, _ := runtime.DefaultUnstructuredConverter.ToUnstructured(dep)
	dep.ManagedFields = []metav1.ManagedFieldsEntry{{Manager: "argocd-controller", Operation: "Apply", FieldsType: "FieldsV1",
		FieldsV1: &metav1.FieldsV1{Raw: []byte(`{"f:spec":{"f:replicas":{}}}`)}}}
	raw, _ = runtime.DefaultUnstructuredConverter.ToUnstructured(dep)
	_ = raw
	c.dynamic = dynamicfake.NewSimpleDynamicClient(scheme.Scheme, dep.DeepCopy())
	c.id = "prod-eu-west-1"
	c.env = func() Environment { return EnvProd }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := c.start(ctx, "sre-oncall", false); err != nil {
		t.Fatal(err)
	}
	defer c.stop()
	c.mu.Lock()
	c.podUsage = map[string]Usage{"payments/" + ok1.Name: {CPUMilli: 184, MemoryMiB: 231}, "payments/" + ok2.Name: {CPUMilli: 176, MemoryMiB: 226}}
	c.nodeUsage = map[string]Usage{node.Name: {CPUMilli: 3955, MemoryMiB: 14233}}
	c.mu.Unlock()
	for i := 0; i < 6; i++ {
		c.samples.add("payments/"+crash.Name+"/api", time.Now().Add(time.Duration(i-6)*15*time.Second), float32(180+i*12))
	}
	waitFor(t, "sync", c.synced)

	m := managerWith(c, false)
	m.state[c.id].Name, m.state[c.id].Env, m.state[c.id].Protected = "prod-eu-west-1", EnvProd, true
	detail, err := m.GetPodDetail(c.id, "payments", crash.Name)
	if err != nil {
		t.Fatal(err)
	}
	live, err := m.GetObject(c.id, "Deployment", "payments", "checkout-api")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	fixture := map[string]any{
		"snapshot": Snapshot{
			Pods: c.allPodRows(EnvProd, now), Deployments: c.allDeploymentRows(EnvProd, now), Nodes: c.allNodeRows(EnvProd, now),
			Helm: []HelmRelease{}, GitOps: []GitOpsObject{},
		},
		"podDetail":  detail,
		"liveObject": live,
	}
	b, err := json.MarshalIndent(fixture, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(out, b, 0o644); err != nil {
		t.Fatal(err)
	}
}
