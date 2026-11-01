package kube

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func rl(kv ...string) corev1.ResourceList {
	out := corev1.ResourceList{}
	for i := 0; i < len(kv); i += 2 {
		out[corev1.ResourceName(kv[i])] = resource.MustParse(kv[i+1])
	}
	return out
}

func quota(ns, name string, hard, used corev1.ResourceList, scopes ...corev1.ResourceQuotaScope) *corev1.ResourceQuota {
	return &corev1.ResourceQuota{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name},
		Spec:       corev1.ResourceQuotaSpec{Hard: hard, Scopes: scopes},
		Status:     corev1.ResourceQuotaStatus{Hard: hard, Used: used},
	}
}

func TestQuotasReportUseAndFullness(t *testing.T) {
	client := fake.NewClientset(
		quota("payments", "compute", rl("pods", "50", "requests.cpu", "8", "limits.memory", "32Gi"), rl("pods", "50", "requests.cpu", "7500m", "limits.memory", "22Gi")),
		quota("search", "compute", rl("requests.cpu", "12"), rl("requests.cpu", "3"), corev1.ResourceQuotaScopeNotBestEffort),
		quota("checkout", "objects", rl("services.loadbalancers", "0"), rl("services.loadbalancers", "0")),
		&corev1.LimitRange{ObjectMeta: metav1.ObjectMeta{Namespace: "payments", Name: "defaults"}, Spec: corev1.LimitRangeSpec{Limits: []corev1.LimitRangeItem{
			{Type: corev1.LimitTypeContainer, DefaultRequest: rl("cpu", "100m"), Default: rl("cpu", "500m", "memory", "512Mi"), Max: rl("cpu", "2")},
			{Type: corev1.LimitTypePersistentVolumeClaim, Min: rl("storage", "1Gi"), Max: rl("storage", "100Gi")},
		}}},
	)
	r := readQuotas(context.Background(), "c", client, "")
	if len(r.Quotas) != 3 {
		t.Fatalf("quotas = %+v", r.Quotas)
	}
	// Full first: payments (pods 50/50) and checkout (0 of 0 allowed), then search at 25 %.
	if r.Quotas[2].Namespace != "search" {
		t.Fatalf("order = %s, %s, %s", r.Quotas[0].Namespace, r.Quotas[1].Namespace, r.Quotas[2].Namespace)
	}
	var pay QuotaInfo
	for _, q := range r.Quotas {
		if q.Namespace == "payments" {
			pay = q
		}
	}
	if it := pay.Items[0]; it.Resource != "pods" || !it.Full || it.Used != "50" || it.Hard != "50" || it.Ratio != 1 {
		t.Fatalf("pods = %+v", it)
	}
	if it := pay.Items[1]; it.Resource != "requests.cpu" || it.Full || it.Ratio < 0.937 || it.Ratio > 0.938 {
		t.Fatalf("cpu = %+v", it)
	}
	if got := r.Quotas[2].Scopes; len(got) != 1 || got[0] != "NotBestEffort" {
		t.Fatalf("scopes = %v", got)
	}
	if len(r.Limits) != 1 || len(r.Limits[0].Items) != 3 {
		t.Fatalf("limits = %+v", r.Limits)
	}
	cpu := r.Limits[0].Items[0]
	if cpu.Type != "Container" || cpu.Resource != "cpu" || cpu.DefaultRequest != "100m" || cpu.Default != "500m" || cpu.Max != "2" || cpu.Min != "" {
		t.Fatalf("container cpu = %+v", cpu)
	}
	// payments: requests.cpu has a default (100m), limits.memory too (512Mi).
	// search's quota is scoped, so it makes no rule.
	want := []QuotaRule{
		{Namespace: "payments", Kind: "defaults", Resource: "limits.memory", Quota: "compute", Value: "512Mi"},
		{Namespace: "payments", Kind: "defaults", Resource: "requests.cpu", Quota: "compute", Value: "100m"},
	}
	if len(r.Rules) != len(want) {
		t.Fatalf("rules = %+v", r.Rules)
	}
	for i := range want {
		if r.Rules[i] != want[i] {
			t.Fatalf("rule %d = %+v, want %+v", i, r.Rules[i], want[i])
		}
	}
}

func TestQuotaWithoutDefaultsNeedsRequests(t *testing.T) {
	quotas := []corev1.ResourceQuota{*quota("team", "q", rl("cpu", "4", "limits.memory", "8Gi", "pods", "10"), nil)}
	got := quotaRules(quotas, nil)
	if len(got) != 2 || got[0].Resource != "limits.memory" || got[0].Kind != "needs" || got[1].Resource != "requests.cpu" || got[1].Kind != "needs" {
		t.Fatalf("rules = %+v (cpu is requests.cpu)", got)
	}
	// A default limit fills the request in too.
	lr := []corev1.LimitRange{{ObjectMeta: metav1.ObjectMeta{Namespace: "team"}, Spec: corev1.LimitRangeSpec{Limits: []corev1.LimitRangeItem{{Type: corev1.LimitTypeContainer, Default: rl("cpu", "1")}}}}}
	got = quotaRules(quotas, lr)
	if got[1].Kind != "defaults" || got[1].Value != "1" || got[0].Kind != "needs" {
		t.Fatalf("rules with a default limit = %+v", got)
	}
}

func TestQuotasFallBackToTheContextNamespace(t *testing.T) {
	client := fake.NewClientset(quota("team", "q", rl("pods", "10"), rl("pods", "3")))
	client.PrependReactor("list", "*", func(a k8stesting.Action) (bool, runtime.Object, error) {
		if a.GetNamespace() == "" {
			return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: a.GetResource().Resource}, "", nil)
		}
		return false, nil, nil
	})
	r := readQuotas(context.Background(), "c", client, "team")
	if len(r.Quotas) != 1 || r.Quotas[0].Items[0].Used != "3" {
		t.Fatalf("quotas = %+v", r.Quotas)
	}
	if n := strings.Join(r.Notes, "\n"); !strings.Contains(n, "ResourceQuotas: only namespace team") || !strings.Contains(n, "LimitRanges: only namespace team") {
		t.Fatalf("notes = %q", n)
	}
	r = readQuotas(context.Background(), "c", client, "")
	if n := strings.Join(r.Notes, "\n"); !strings.Contains(n, "ResourceQuotas: not allowed to list") {
		t.Fatalf("notes without a fallback = %q", n)
	}
}
