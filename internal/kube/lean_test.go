package kube

import (
	"fmt"
	"reflect"
	"runtime"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
)

func richPod(i int) *corev1.Pod {
	probe := &corev1.Probe{ProbeHandler: corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Path: "/healthz", Port: intstr.FromInt32(8080)}}, PeriodSeconds: 10}
	env := []corev1.EnvVar{
		{Name: "DATABASE_URL", Value: "postgres://app:s3cret@db:5432/app?sslmode=require"},
		{Name: "LOG_LEVEL", Value: "info"},
		{Name: "FEATURE_FLAGS", Value: "checkout-v2,ledger-batch,search-reindex,payments-retry"},
		{Name: "API_KEY", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: "api-key"}, Key: "key"}}},
		{Name: "MODE", ValueFrom: &corev1.EnvVarSource{ConfigMapKeyRef: &corev1.ConfigMapKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: "app-config"}, Key: "mode"}}},
	}
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("api-%05d", i), Namespace: "payments", UID: "u", CreationTimestamp: metav1.Now(),
			Labels:          map[string]string{"app": "api"},
			Annotations:     map[string]string{lastApplied: `{"apiVersion":"v1","kind":"Pod","metadata":{"name":"api"},"spec":{"containers":[{"name":"api","image":"ghcr.io/acme/api:1.4.2","env":[{"name":"DATABASE_URL","value":"postgres://app:s3cret@db:5432/app"}]}]}}`},
			ManagedFields:   []metav1.ManagedFieldsEntry{{Manager: "kubectl", Operation: "Apply"}},
			OwnerReferences: []metav1.OwnerReference{{Kind: "ReplicaSet", Name: "api-7d9f8b6c4", Controller: ptr(true)}}},
		Spec: corev1.PodSpec{NodeName: "node-1",
			Volumes: []corev1.Volume{{Name: "cfg", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: "app-config"}}}}},
			Containers: []corev1.Container{{Name: "api", Image: "ghcr.io/acme/api:1.4.2",
				Command: []string{"/app/server"}, Args: []string{"--port=8080", "--metrics=:9090", "--tracing=otel", "--config=/etc/app/config.yaml"},
				Env: env, EnvFrom: []corev1.EnvFromSource{{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "common"}}}},
				Ports:         []corev1.ContainerPort{{Name: "http", ContainerPort: 8080}},
				Resources:     corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("250m"), corev1.ResourceMemory: resource.MustParse("256Mi")}},
				LivenessProbe: probe, ReadinessProbe: probe, StartupProbe: probe,
				Lifecycle: &corev1.Lifecycle{PreStop: &corev1.LifecycleHandler{Exec: &corev1.ExecAction{Command: []string{"sh", "-c", "sleep 5"}}}}}}},
		Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{{Name: "api", Ready: true, RestartCount: 2, Image: "ghcr.io/acme/api:1.4.2"}}},
	}
}

// Every row and relation built from a lean object equals the one built from
// the full object; the dropped fields are not read from the cache.
func TestLeanCacheKeepsWhatViewsRead(t *testing.T) {
	now := time.Now()
	full := richPod(1)
	lean := full.DeepCopy()
	_, _ = stripManagedFields(lean)
	owner := func(string, string) *OwnerRef { return &OwnerRef{Kind: "Deployment", Name: "api"} }
	if a, b := ToPodRow(full, "c", EnvProd, nil, PodOwner(full, owner), now), ToPodRow(lean, "c", EnvProd, nil, PodOwner(lean, owner), now); !reflect.DeepEqual(a, b) {
		t.Fatalf("pod row changed:\nfull %+v\nlean %+v", a, b)
	}
	if a, b := templateUses(full.Spec), templateUses(lean.Spec); !reflect.DeepEqual(a, b) {
		t.Fatalf("relations changed:\nfull %+v\nlean %+v", a, b)
	}
	cr, cl, mr, ml := PodRequests(full)
	if r2, l2, m2, ml2 := PodRequests(lean); cr != r2 || cl != l2 || mr != m2 || ml != ml2 {
		t.Fatal("requests changed")
	}
	dep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "payments", Annotations: map[string]string{lastApplied: "{}", "deployment.kubernetes.io/revision": "4"}},
		Spec: appsv1.DeploymentSpec{Replicas: ptr(int32(3)), Template: corev1.PodTemplateSpec{Spec: *full.Spec.DeepCopy()}}}
	leanDep := dep.DeepCopy()
	_, _ = stripManagedFields(leanDep)
	if a, b := ToDeploymentRow(dep, "c", EnvProd, nil, nil, nil, now), ToDeploymentRow(leanDep, "c", EnvProd, nil, nil, nil, now); !reflect.DeepEqual(a, b) {
		t.Fatalf("deployment row changed:\nfull %+v\nlean %+v", a, b)
	}
	if a, b := templateUses(dep.Spec.Template.Spec), templateUses(leanDep.Spec.Template.Spec); !reflect.DeepEqual(a, b) {
		t.Fatal("deployment relations changed")
	}
	// What is gone is gone: no literal env value (a credential here) stays in memory.
	for _, e := range lean.Spec.Containers[0].Env {
		if e.Value != "" || e.ValueFrom == nil {
			t.Fatalf("env kept: %+v", e)
		}
	}
	if _, ok := lean.Annotations[lastApplied]; ok || lean.Spec.Containers[0].LivenessProbe != nil {
		t.Fatal("last-applied and probes are dropped")
	}
}

// The Go heap that 10,000 cached pods take, with and without the lean transform.
func TestLeanCacheIsSmaller(t *testing.T) {
	measure := func(lean bool) float64 {
		runtime.GC()
		var before runtime.MemStats
		runtime.ReadMemStats(&before)
		keep := make([]*corev1.Pod, 10_000)
		for i := range keep {
			p := richPod(i)
			if lean {
				_, _ = stripManagedFields(p)
				p = p.DeepCopy() // the cache holds the transformed object; dropped parts become garbage
			} else {
				p.ManagedFields = nil // what the cache held before
			}
			keep[i] = p
		}
		runtime.GC()
		var after runtime.MemStats
		runtime.ReadMemStats(&after)
		runtime.KeepAlive(keep)
		return float64(after.HeapAlloc-before.HeapAlloc) / (1 << 20)
	}
	before, after := measure(false), measure(true)
	t.Logf("10,000 cached pods: %.1f MB before, %.1f MB lean", before, after)
	if after >= before*0.9 {
		t.Fatalf("lean cache %.1f MB is not clearly smaller than %.1f MB", after, before)
	}
}
