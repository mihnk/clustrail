package kube

import (
	"errors"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

func TestDiscoveryRetriesAndSeesNewKinds(t *testing.T) {
	defer func(ttl, retry time.Duration) { kindsTTL, kindsRetry = ttl, retry }(kindsTTL, kindsRetry)
	kindsTTL, kindsRetry = time.Hour, 30*time.Millisecond
	c, client, _ := newFakeConn(t)
	c.disc = client.Discovery()
	core := &metav1.APIResourceList{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "pods", Kind: "Pod", Namespaced: true, Verbs: []string{"list"}}}}
	// Nothing served at first (an API server still starting): the miss is not kept for good.
	client.Fake.Resources = nil
	if _, _, err := c.resolve("Pod"); err == nil {
		t.Fatal("nothing served yet: resolve must fail")
	}
	client.Fake.Resources = []*metav1.APIResourceList{core}
	time.Sleep(40 * time.Millisecond)
	if _, _, err := c.resolve("Pod"); err != nil {
		t.Fatalf("after a retry: %v", err)
	}
	// A CRD installed later is found on the miss, without waiting for the TTL.
	client.Fake.Resources = append(client.Fake.Resources, &metav1.APIResourceList{GroupVersion: "cert-manager.io/v1", APIResources: []metav1.APIResource{{Name: "certificates", Kind: "Certificate", Namespaced: true, Verbs: []string{"list"}}}})
	time.Sleep(40 * time.Millisecond)
	if gvr, ns, err := c.resolve("cert-manager.io/Certificate"); err != nil || gvr.Resource != "certificates" || !ns {
		t.Fatalf("new CRD: %v %v %v", gvr, ns, err)
	}
	kinds, err := c.listableKinds()
	if err != nil || len(kinds) != 2 {
		t.Fatalf("listable = %v %v", kinds, err)
	}
}

func TestDiscoveryErrorIsRetried(t *testing.T) {
	defer func(ttl, retry time.Duration) { kindsTTL, kindsRetry = ttl, retry }(kindsTTL, kindsRetry)
	kindsTTL, kindsRetry = time.Hour, 30*time.Millisecond
	c, client, _ := newFakeConn(t)
	failing := &failingDiscovery{DiscoveryInterface: client.Discovery(), fail: true}
	c.disc = failing
	client.Fake.Resources = []*metav1.APIResourceList{{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "pods", Kind: "Pod", Namespaced: true, Verbs: []string{"list"}}}}}
	if _, _, err := c.resolve("Pod"); err == nil || err.Error() != "connection refused" {
		t.Fatalf("first discovery err = %v", err)
	}
	failing.fail = false
	if _, _, err := c.resolve("Pod"); err == nil {
		t.Fatal("within kindsRetry the error stands")
	}
	time.Sleep(40 * time.Millisecond)
	if _, _, err := c.resolve("Pod"); err != nil {
		t.Fatalf("after kindsRetry discovery runs again: %v", err)
	}
}

type failingDiscovery struct {
	discovery.DiscoveryInterface
	fail bool
}

func (f *failingDiscovery) ServerGroupsAndResources() ([]*metav1.APIGroup, []*metav1.APIResourceList, error) {
	if f.fail {
		return nil, nil, errors.New("connection refused")
	}
	return f.DiscoveryInterface.ServerGroupsAndResources()
}

func TestCustomKindsComeFromCRDs(t *testing.T) {
	c, client, _ := newFakeConn(t)
	c.disc = client.Discovery()
	crd := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
		"metadata": map[string]any{"name": "certificates.cert-manager.io"},
	}}
	c.dynamic = dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{crdGVR: "CustomResourceDefinitionList"}, crd)
	list := func(gv string, rs ...metav1.APIResource) *metav1.APIResourceList {
		for i := range rs {
			rs[i].Verbs = []string{"list"}
		}
		return &metav1.APIResourceList{GroupVersion: gv, APIResources: rs}
	}
	client.Fake.Resources = []*metav1.APIResourceList{
		list("v1", metav1.APIResource{Name: "pods", Kind: "Pod", Namespaced: true}),
		list("apiextensions.k8s.io/v1", metav1.APIResource{Name: "customresourcedefinitions", Kind: "CustomResourceDefinition"}),
		list("cert-manager.io/v1", metav1.APIResource{Name: "certificates", Kind: "Certificate", Namespaced: true}),
		// Aggregated, not a CRD.
		list("metrics.k8s.io/v1beta1", metav1.APIResource{Name: "pods", Kind: "PodMetrics", Namespaced: true}),
		// No CRD listed for it here, so not custom.
		list("gateway.networking.k8s.io/v1", metav1.APIResource{Name: "gateways", Kind: "Gateway", Namespaced: true}),
	}
	kinds, err := c.listableKinds()
	if err != nil {
		t.Fatal(err)
	}
	custom := map[string]bool{}
	for _, k := range kinds {
		custom[k.Group+"/"+k.Kind] = k.Custom
	}
	want := map[string]bool{"/Pod": false, "apiextensions.k8s.io/CustomResourceDefinition": false, "cert-manager.io/Certificate": true, "metrics.k8s.io/PodMetrics": false, "gateway.networking.k8s.io/Gateway": false}
	for k, w := range want {
		if custom[k] != w {
			t.Errorf("%s custom = %v, want %v", k, custom[k], w)
		}
	}
}

func TestCustomKindsWithoutCRDAccess(t *testing.T) {
	kinds := []KindInfo{{Kind: "Pod"}, {Kind: "Deployment", Group: "apps"}, {Kind: "Certificate", Group: "cert-manager.io", Resource: "certificates"}}
	markCustom(kinds, nil)
	if kinds[0].Custom || kinds[1].Custom || !kinds[2].Custom {
		t.Fatalf("kinds = %+v", kinds)
	}
}
