package kube

import (
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/scheme"
)

func TestSecretsAreHiddenUntilRevealed(t *testing.T) {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "payments"},
		Type:       corev1.SecretTypeOpaque,
		Data:       map[string][]byte{"password": []byte("hunter2"), "cert": {0xff, 0x00, 0x10}},
	}
	c, client, _ := newFakeConn(t, secret)
	client.Fake.Resources = []*metav1.APIResourceList{{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "secrets", Kind: "Secret", Namespaced: true, Verbs: []string{"get", "list"}}}}}
	c.dynamic = dynamicfake.NewSimpleDynamicClient(scheme.Scheme, secret.DeepCopy())
	m := managerWith(c, false)

	live, err := m.GetObject("test", "Secret", "payments", "db")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(live.YAML, "aHVudGVyMg") || strings.Contains(live.YAML, "hunter2") {
		t.Fatalf("value leaked into YAML:\n%s", live.YAML)
	}
	if !strings.Contains(live.YAML, "password: (hidden, 7 bytes)") {
		t.Fatalf("placeholder missing:\n%s", live.YAML)
	}
	if live.Secret == nil || len(live.Secret.Keys) != 2 || live.Secret.Keys[1].Key != "password" || live.Secret.Keys[1].Bytes != 7 || live.Secret.Type != "Opaque" {
		t.Fatalf("info = %+v", live.Secret)
	}

	v, err := m.RevealSecretKey("test", "payments", "db", "password")
	if err != nil || v.Value != "hunter2" || v.Binary {
		t.Fatalf("reveal = %+v %v", v, err)
	}
	if v, _ := m.RevealSecretKey("test", "payments", "db", "cert"); !v.Binary || v.Value != "/wAQ" {
		t.Fatalf("binary = %+v", v)
	}

	// An edit that keeps the placeholder keeps the live value; a rewritten key changes.
	edited := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Secret", "metadata": map[string]any{"name": "db", "namespace": "payments"},
		"data": map[string]any{"password": "(hidden, 7 bytes)", "cert": "bmV3"},
	}}
	if err := unmaskSecret(c, edited); err != nil {
		t.Fatal(err)
	}
	data, _, _ := unstructured.NestedStringMap(edited.Object, "data")
	if data["password"] != "aHVudGVyMg==" || data["cert"] != "bmV3" {
		t.Fatalf("data = %v", data)
	}
	gone := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Secret", "metadata": map[string]any{"name": "db", "namespace": "payments"},
		"data": map[string]any{"token": "(hidden, 3 bytes)"},
	}}
	if err := unmaskSecret(c, gone); err == nil {
		t.Fatal("a placeholder for a key the Secret does not have must be refused")
	}
}

func TestLastAppliedCopyOfASecretIsMasked(t *testing.T) {
	applied := `{"apiVersion":"v1","data":{"password":"aHVudGVyMg=="},"kind":"Secret","metadata":{"name":"db","namespace":"payments"},"stringData":{"token":"s3cret"},"type":"Opaque"}`
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "payments", Annotations: map[string]string{lastApplied: applied, "team": "billing"}},
		Type:       corev1.SecretTypeOpaque,
		Data:       map[string][]byte{"password": []byte("hunter2")},
	}
	c, client, _ := newFakeConn(t, secret)
	client.Fake.Resources = []*metav1.APIResourceList{{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "secrets", Kind: "Secret", Namespaced: true, Verbs: []string{"get", "list"}}}}}
	c.dynamic = dynamicfake.NewSimpleDynamicClient(scheme.Scheme, secret.DeepCopy())
	m := managerWith(c, false)

	live, err := m.GetObject("test", "Secret", "payments", "db")
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"hunter2", "aHVudGVyMg", "s3cret"} {
		if strings.Contains(live.YAML, leak) {
			t.Fatalf("%q leaked into YAML:\n%s", leak, live.YAML)
		}
	}
	if !strings.Contains(live.YAML, `{"apiVersion":"v1","data":{"password":"(hidden,`) || !strings.Contains(live.YAML, "team: billing") {
		t.Fatalf("masked annotation:\n%s", live.YAML)
	}

	// Saving the YAML as shown keeps the live last-applied copy, not placeholders.
	edited := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Secret",
		"metadata": map[string]any{"name": "db", "namespace": "payments", "annotations": map[string]any{lastApplied: `{"data":{"password":"(hidden, 7 bytes)"}}`}},
		"data":     map[string]any{"password": "(hidden, 7 bytes)"},
	}}
	if err := unmaskSecret(c, edited); err != nil {
		t.Fatal(err)
	}
	if got := edited.GetAnnotations()[lastApplied]; got != applied {
		t.Fatalf("annotation after save = %q", got)
	}

	// Unreadable copies are hidden whole.
	broken := &unstructured.Unstructured{Object: map[string]any{"metadata": map[string]any{"annotations": map[string]any{lastApplied: "{not json hunter2"}}}}
	maskLastApplied(broken)
	if strings.Contains(broken.GetAnnotations()[lastApplied], "hunter2") {
		t.Fatal("an unreadable copy must not be shown")
	}
}
