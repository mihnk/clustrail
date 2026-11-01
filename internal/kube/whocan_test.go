package kube

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	k8stesting "k8s.io/client-go/testing"
)

func rbacFixture() []runtime.Object {
	cr := func(name string, rules ...rbacv1.PolicyRule) *rbacv1.ClusterRole {
		return &rbacv1.ClusterRole{ObjectMeta: metav1.ObjectMeta{Name: name}, Rules: rules}
	}
	rule := func(groups, resources, verbs []string, names ...string) rbacv1.PolicyRule {
		return rbacv1.PolicyRule{APIGroups: groups, Resources: resources, Verbs: verbs, ResourceNames: names}
	}
	crb := func(name, role string, subjects ...rbacv1.Subject) *rbacv1.ClusterRoleBinding {
		return &rbacv1.ClusterRoleBinding{ObjectMeta: metav1.ObjectMeta{Name: name}, RoleRef: rbacv1.RoleRef{Kind: "ClusterRole", Name: role}, Subjects: subjects}
	}
	rb := func(name, kind, role string, subjects ...rbacv1.Subject) *rbacv1.RoleBinding {
		return &rbacv1.RoleBinding{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "payments"}, RoleRef: rbacv1.RoleRef{Kind: kind, Name: role}, Subjects: subjects}
	}
	user := func(n string) rbacv1.Subject { return rbacv1.Subject{Kind: "User", Name: n} }
	group := func(n string) rbacv1.Subject { return rbacv1.Subject{Kind: "Group", Name: n} }
	sa := func(ns, n string) rbacv1.Subject {
		return rbacv1.Subject{Kind: "ServiceAccount", Namespace: ns, Name: n}
	}
	return []runtime.Object{
		cr("cluster-admin", rule([]string{"*"}, []string{"*"}, []string{"*"})),
		cr("secret-reader", rule([]string{""}, []string{"secrets", "configmaps"}, []string{"get", "list", "watch"})),
		cr("pod-reader", rule([]string{""}, []string{"pods"}, []string{"get", "list"})),
		cr("debugger", rule([]string{""}, []string{"pods/exec"}, []string{"create"})),
		crb("cluster-admin", "cluster-admin", group("system:masters")),
		crb("prometheus", "secret-reader", sa("monitoring", "prometheus")),
		crb("viewers", "pod-reader", group("viewers")),
		&rbacv1.Role{ObjectMeta: metav1.ObjectMeta{Name: "read-ledger", Namespace: "payments"}, Rules: []rbacv1.PolicyRule{rule([]string{""}, []string{"secrets"}, []string{"get"}, "ledger-db")}},
		rb("ledger", "Role", "read-ledger", rbacv1.Subject{Kind: "ServiceAccount", Name: "ledger"}),
		rb("oncall-debug", "ClusterRole", "debugger", user("jane@acme.io")),
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "ledger-0", Namespace: "payments"}, Spec: corev1.PodSpec{ServiceAccountName: "ledger"}},
	}
}

func whoCanConn(t *testing.T) (*clusterConn, *Manager) {
	t.Helper()
	c, client, _ := newFakeConn(t, rbacFixture()...)
	client.Fake.Resources = []*metav1.APIResourceList{
		{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "secrets", Kind: "Secret", Namespaced: true}, {Name: "pods", Kind: "Pod", Namespaced: true}, {Name: "nodes", Kind: "Node"}}},
	}
	return c, managerWith(c, false)
}

func subjects(r WhoCanResult) map[string]WhoCanGrant {
	out := map[string]WhoCanGrant{}
	for _, g := range r.Grants {
		out[g.SubjectKind+" "+g.Subject] = g
	}
	return out
}

func TestWhoCanReadASecret(t *testing.T) {
	_, m := whoCanConn(t)
	res, err := m.WhoCan(WhoCanRequest{Cluster: "test", Verb: "get", Kind: "Secret", Namespace: "payments", Name: "ledger-db"})
	if err != nil {
		t.Fatal(err)
	}
	got := subjects(res)
	if len(got) != 3 {
		t.Fatalf("grants = %+v", res.Grants)
	}
	if g := got["Group system:masters"]; g.Scope != "cluster-wide" || !g.Wide || g.Role != "ClusterRole cluster-admin" {
		t.Fatalf("system:masters = %+v", g)
	}
	if g := got["ServiceAccount monitoring/prometheus"]; g.Scope != "cluster-wide" || g.Rule != "secrets, configmaps: get, list, watch" {
		t.Fatalf("prometheus = %+v", g)
	}
	// A ServiceAccount subject without a namespace is the binding's.
	if g := got["ServiceAccount payments/ledger"]; g.Scope != "payments" || g.Wide || g.Binding != "RoleBinding ledger" {
		t.Fatalf("ledger = %+v", g)
	}
	if pods := res.ServiceAccountPods["payments/ledger"]; len(pods) != 0 {
		t.Fatalf("pods are read from the cache only; none here: %v", pods)
	}
	if res.Grants[0].Subject != "system:masters" && res.Grants[0].Subject != "monitoring/prometheus" {
		t.Fatalf("wide grants come first: %+v", res.Grants[0])
	}

	// Another Secret: the rule naming ledger-db does not apply.
	res, _ = m.WhoCan(WhoCanRequest{Cluster: "test", Verb: "get", Kind: "Secret", Namespace: "payments", Name: "other"})
	if _, ok := subjects(res)["ServiceAccount payments/ledger"]; ok {
		t.Fatal("a rule with resourceNames must not grant other names")
	}
	// No name asked: the named rule shows as limited to its names; list is never limited by name.
	res, _ = m.WhoCan(WhoCanRequest{Cluster: "test", Verb: "get", Kind: "Secret", Namespace: "payments"})
	if g := subjects(res)["ServiceAccount payments/ledger"]; len(g.OnlyNames) != 1 || g.OnlyNames[0] != "ledger-db" {
		t.Fatalf("only names = %+v", g)
	}
	res, _ = m.WhoCan(WhoCanRequest{Cluster: "test", Verb: "list", Kind: "Secret", Namespace: "payments"})
	if _, ok := subjects(res)["ServiceAccount payments/ledger"]; ok {
		t.Fatal("resourceNames never allow list")
	}
}

func TestWhoCanExecAndClusterScoped(t *testing.T) {
	_, m := whoCanConn(t)
	res, err := m.WhoCan(WhoCanRequest{Cluster: "test", Verb: "exec", Kind: "Pod", Namespace: "payments", Name: "ledger-0"})
	if err != nil {
		t.Fatal(err)
	}
	got := subjects(res)
	if res.Resource != "pods/exec" || len(got) != 2 || got["User jane@acme.io"].Scope != "payments" {
		t.Fatalf("exec = %s %+v", res.Resource, res.Grants)
	}
	if _, ok := got["Group viewers"]; ok {
		t.Fatal("reading pods does not allow exec")
	}
	if _, err := m.WhoCan(WhoCanRequest{Cluster: "test", Verb: "exec", Kind: "Secret", Namespace: "payments"}); err == nil {
		t.Fatal("exec is only about pods")
	}
	// Nodes are cluster-scoped: namespaced bindings never apply.
	res, _ = m.WhoCan(WhoCanRequest{Cluster: "test", Verb: "delete", Kind: "Node", Namespace: "payments", Name: "n1"})
	if res.Request.Namespace != "" || len(res.Grants) != 1 || res.Grants[0].Subject != "system:masters" {
		t.Fatalf("nodes = %+v", res)
	}
}

// Without the right to list some RBAC kinds the answer says which are missing.
func TestWhoCanSaysWhatItCouldNotRead(t *testing.T) {
	c, m := whoCanConn(t)
	c.client.(interface {
		PrependReactor(verb, resource string, fn k8stesting.ReactionFunc)
	}).PrependReactor("list", "clusterrolebindings", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Group: "rbac.authorization.k8s.io", Resource: "clusterrolebindings"}, "", nil)
	})
	res, err := m.WhoCan(WhoCanRequest{Cluster: "test", Verb: "get", Kind: "Secret", Namespace: "payments", Name: "ledger-db"})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Missing) != 1 || res.Missing[0] != "ClusterRoleBindings" || len(res.Grants) != 1 {
		t.Fatalf("result = %+v", res)
	}
}

func TestMatchResource(t *testing.T) {
	for _, tc := range []struct {
		list []string
		res  string
		want bool
	}{
		{[]string{"pods"}, "pods", true},
		{[]string{"pods"}, "pods/exec", false},
		{[]string{"pods/*"}, "pods/exec", true},
		{[]string{"*/exec"}, "pods/exec", true},
		{[]string{"*"}, "pods/exec", true},
		{[]string{"secrets"}, "pods", false},
	} {
		if got := matchResource(tc.list, tc.res); got != tc.want {
			t.Errorf("matchResource(%v, %q) = %v", tc.list, tc.res, got)
		}
	}
}
