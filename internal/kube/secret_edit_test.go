package kube

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func secretObj(name string, data map[string]string, mutate ...func(*corev1.Secret)) *corev1.Secret {
	s := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "payments", ResourceVersion: "7"}, Type: corev1.SecretTypeOpaque, Data: map[string][]byte{}}
	for k, v := range data {
		s.Data[k] = []byte(v)
	}
	for _, f := range mutate {
		f(s)
	}
	return s
}

func TestSecretEditChangesOnlyWhatWasSent(t *testing.T) {
	c, client, _ := newFakeConn(t, secretObj("db", map[string]string{"username": "app", "password": "old", "legacy": "x"}))
	m := managerWith(c, false)
	info, err := m.SecretForEdit("test", "payments", "db")
	if err != nil {
		t.Fatal(err)
	}
	if info.ResourceVersion != "7" || len(info.Keys) != 3 || info.Keys[0].Key != "legacy" || info.Immutable || info.Warning != "" {
		t.Fatalf("info = %+v", info)
	}
	_, err = m.UpdateSecret(SecretUpdate{
		Cluster: "test", Namespace: "payments", Name: "db", ResourceVersion: "7",
		Set:    map[string]SecretEditValue{"password": {Value: "n3w"}, "ca.crt": {Value: "AAEC/w==", Binary: true}},
		Remove: []string{"legacy"},
	})
	if err != nil {
		t.Fatal(err)
	}
	s, _ := client.CoreV1().Secrets("payments").Get(context.Background(), "db", metav1.GetOptions{})
	if string(s.Data["username"]) != "app" || string(s.Data["password"]) != "n3w" || string(s.Data["ca.crt"]) != "\x00\x01\x02\xff" {
		t.Fatalf("data = %q", s.Data)
	}
	if _, ok := s.Data["legacy"]; ok {
		t.Fatal("removed key kept")
	}
}

func TestSecretEditRefusals(t *testing.T) {
	immutable := true
	c, _, _ := newFakeConn(t,
		secretObj("db", map[string]string{"a": "1"}),
		secretObj("frozen", map[string]string{"a": "1"}, func(s *corev1.Secret) { s.Immutable = &immutable }),
		secretObj("sh.helm.release.v1.x.v1", map[string]string{"release": "x"}, func(s *corev1.Secret) { s.Type = "helm.sh/release.v1" }),
		secretObj("argo", map[string]string{"a": "1"}, func(s *corev1.Secret) { s.Labels = map[string]string{"argocd.argoproj.io/instance": "app"} }),
	)
	m := managerWith(c, false)
	cases := map[string]SecretUpdate{
		"changed since":        {Name: "db", ResourceVersion: "6", Set: map[string]SecretEditValue{"a": {Value: "2"}}},
		"immutable":            {Name: "frozen", ResourceVersion: "7", Set: map[string]SecretEditValue{"a": {Value: "2"}}},
		"not valid base64":     {Name: "db", ResourceVersion: "7", Set: map[string]SecretEditValue{"a": {Value: "%%%", Binary: true}}},
		"valid config key":     {Name: "db", ResourceVersion: "7", Set: map[string]SecretEditValue{"bad key": {Value: "x"}}},
		"both set and removed": {Name: "db", ResourceVersion: "7", Set: map[string]SecretEditValue{"a": {Value: "x"}}, Remove: []string{"a"}},
		"not in the Secret":    {Name: "db", ResourceVersion: "7", Remove: []string{"nope"}},
		"nothing to change":    {Name: "db", ResourceVersion: "7"},
	}
	for want, u := range cases {
		u.Cluster, u.Namespace = "test", "payments"
		if _, err := m.UpdateSecret(u); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v", want, err)
		}
	}
	if i, _ := m.SecretForEdit("test", "payments", "frozen"); !i.Immutable {
		t.Error("immutable not reported")
	}
	if i, _ := m.SecretForEdit("test", "payments", "sh.helm.release.v1.x.v1"); !strings.Contains(i.Warning, "Helm release record") {
		t.Errorf("helm warning = %q", i.Warning)
	}
	if i, _ := m.SecretForEdit("test", "payments", "argo"); !strings.Contains(i.Warning, "Argo CD") {
		t.Errorf("argo warning = %q", i.Warning)
	}
	ro := managerWith(c, true)
	if _, err := ro.UpdateSecret(SecretUpdate{Cluster: "test", Namespace: "payments", Name: "db", ResourceVersion: "7", Set: map[string]SecretEditValue{"a": {Value: "2"}}}); err != ErrReadOnly {
		t.Fatalf("read-only err = %v", err)
	}
}
