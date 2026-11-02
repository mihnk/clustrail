//go:build envtest

package kube

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Against a real API server: an edit applies, and one that raced with
// another write is refused.
func TestSecretEditAgainstAPIServer(t *testing.T) {
	env := startEnvCluster(t, envtestBins(t))
	admin := adminClient(t, env.host)
	ctx := context.Background()
	_, _ = admin.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "payments"}}, metav1.CreateOptions{})
	if _, err := admin.CoreV1().Secrets("payments").Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "db"}, StringData: map[string]string{"user": "app", "password": "old"}}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	m := chaosManager(t, env.host)
	info, err := m.SecretForEdit("envtest", "payments", "db")
	if err != nil {
		t.Fatal(err)
	}
	rv, err := m.UpdateSecret(SecretUpdate{Cluster: "envtest", Namespace: "payments", Name: "db", ResourceVersion: info.ResourceVersion, Set: map[string]SecretEditValue{"password": {Value: "n3w"}}})
	if err != nil {
		t.Fatal(err)
	}
	s, _ := admin.CoreV1().Secrets("payments").Get(ctx, "db", metav1.GetOptions{})
	if string(s.Data["password"]) != "n3w" || string(s.Data["user"]) != "app" || s.ResourceVersion != rv {
		t.Fatalf("after edit: %q rv %s/%s", s.Data, s.ResourceVersion, rv)
	}
	// Someone else writes; an edit from the earlier version is refused.
	s.Data["user"] = []byte("other")
	if _, err := admin.CoreV1().Secrets("payments").Update(ctx, s, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	_, err = m.UpdateSecret(SecretUpdate{Cluster: "envtest", Namespace: "payments", Name: "db", ResourceVersion: rv, Set: map[string]SecretEditValue{"password": {Value: "lost"}}})
	if err == nil || !strings.Contains(err.Error(), "changed since it was opened") {
		t.Fatalf("stale edit err = %v", err)
	}
	s, _ = admin.CoreV1().Secrets("payments").Get(ctx, "db", metav1.GetOptions{})
	if string(s.Data["password"]) != "n3w" || string(s.Data["user"]) != "other" {
		t.Fatalf("the other write was overwritten: %q", s.Data)
	}
}
