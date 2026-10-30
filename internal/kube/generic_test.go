package kube

import (
	"encoding/json"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/scheme"
	k8stesting "k8s.io/client-go/testing"
)

func TestFromTable(t *testing.T) {
	meta, _ := json.Marshal(metav1.PartialObjectMetadata{ObjectMeta: metav1.ObjectMeta{
		Name: "checkout-api", Namespace: "payments", CreationTimestamp: metav1.NewTime(time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)),
	}})
	table := &metav1.Table{
		ColumnDefinitions: []metav1.TableColumnDefinition{
			{Name: "Name", Type: "string"}, {Name: "Type", Type: "string"}, {Name: "Ports", Type: "string", Priority: 0},
			{Name: "Age", Type: "string"}, {Name: "Selector", Type: "string", Priority: 1, Description: "Route traffic to pods. More text."},
		},
		Rows: []metav1.TableRow{{Cells: []any{"checkout-api", "ClusterIP", "80/TCP", "29d", "app=checkout-api"}, Object: runtime.RawExtension{Raw: meta}}},
	}
	l := fromTable(table)
	if len(l.Columns) != 3 || l.Columns[0].Name != "Type" || l.Columns[2].Priority != 1 || l.Columns[2].Description != "Route traffic to pods." {
		t.Fatalf("columns = %+v", l.Columns)
	}
	r := l.Rows[0]
	if r.Name != "checkout-api" || r.Namespace != "payments" || r.Created != "2026-10-01T12:00:00Z" || len(r.Cells) != 3 || r.Cells[1] != "80/TCP" {
		t.Fatalf("row = %+v", r)
	}
	if cellText(float64(3)) != "3" || cellText(nil) != "" {
		t.Fatal("cellText")
	}
}

func TestListResourcesKindsAndDelete(t *testing.T) {
	c, client, _ := newFakeConn(t)
	client.Fake.Resources = []*metav1.APIResourceList{
		{GroupVersion: "v1", APIResources: []metav1.APIResource{
			{Name: "services", Kind: "Service", Namespaced: true, Verbs: []string{"list", "get", "delete"}, ShortNames: []string{"svc"}},
			{Name: "services/status", Kind: "Service", Namespaced: true, Verbs: []string{"get"}},
			{Name: "bindings", Kind: "Binding", Namespaced: true, Verbs: []string{"create"}},
		}},
		{GroupVersion: "batch/v1", APIResources: []metav1.APIResource{{Name: "cronjobs", Kind: "CronJob", Namespaced: true, Verbs: []string{"list"}}}},
	}
	svc := func(ns, name string) *corev1.Service {
		return &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}}
	}
	dyn := dynamicfake.NewSimpleDynamicClient(scheme.Scheme, svc("payments", "checkout-api"), svc("kube-system", "kube-dns"))
	// A namespace-scoped identity: listing across namespaces is denied.
	dyn.PrependReactor("list", "services", func(a k8stesting.Action) (bool, runtime.Object, error) {
		if a.GetNamespace() == "" {
			return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "services"}, "", nil)
		}
		return false, nil, nil
	})
	c.dynamic = dyn
	c.fallbackNS = "payments"
	m := managerWith(c, false)

	kinds, err := m.ResourceKinds("test")
	if err != nil {
		t.Fatal(err)
	}
	if len(kinds) != 2 || kinds[0].Kind != "CronJob" || kinds[1].Kind != "Service" || !kinds[1].Delete || kinds[0].Delete {
		t.Fatalf("kinds = %+v", kinds)
	}

	l, err := m.ListResources("test", "Service", "")
	if err != nil {
		t.Fatal(err)
	}
	if l.Shown != "payments" || len(l.Rows) != 1 || l.Rows[0].ID != "test/payments/checkout-api" || !l.Namespaced {
		t.Fatalf("list = %+v", l)
	}

	ro := managerWith(c, true)
	if err := ro.DeleteResource("test", "Service", "payments", "checkout-api"); err != ErrReadOnly {
		t.Fatalf("read-only delete err = %v", err)
	}
	if err := m.DeleteResource("test", "Service", "payments", "checkout-api"); err != nil {
		t.Fatal(err)
	}
	if l, _ := m.ListResources("test", "Service", "payments"); len(l.Rows) != 0 {
		t.Fatalf("after delete: %+v", l.Rows)
	}
}
