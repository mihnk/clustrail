package kube

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
)

// "Who can?": every subject that an RBAC rule allows a verb on an object,
// with the binding and the rule that grant it. Kubernetes has no reverse
// lookup, so this reads Roles, ClusterRoles and their bindings and matches
// the rules here. It is what the RBAC objects say: webhook authorizers,
// impersonation, node authorization and the cloud provider's own IAM are not
// seen, and the UI says so.

// WhoCanRequest names the question: may anyone <verb> <kind> <name> in <namespace>?
type WhoCanRequest struct {
	Cluster   string `json:"cluster"`
	Verb      string `json:"verb"` // get, list, watch, create, update, patch, delete, or "exec" (create pods/exec)
	Kind      string `json:"kind"` // as for GetObject: "Secret", "apps/Deployment"
	Namespace string `json:"namespace"`
	Name      string `json:"name"` // empty: any object of the kind
}

// WhoCanGrant is one subject and what grants it.
type WhoCanGrant struct {
	SubjectKind string `json:"subjectKind"` // User, Group, ServiceAccount
	Subject     string `json:"subject"`     // a ServiceAccount as namespace/name
	// Scope is "cluster-wide" for a ClusterRoleBinding, else the binding's namespace.
	Scope   string `json:"scope"`
	Binding string `json:"binding"` // "ClusterRoleBinding cluster-admin"
	Role    string `json:"role"`    // "ClusterRole cluster-admin"
	Rule    string `json:"rule"`    // "secrets: get, list, watch"
	// RuleYAML is the matching rule as YAML, for the details pane.
	RuleYAML string `json:"ruleYAML"`
	// Wide: the grant reaches more than this object's namespace, or uses a wildcard.
	Wide bool `json:"wide"`
	// OnlyNames: the rule names objects (resourceNames) and the question named none.
	OnlyNames []string `json:"onlyNames,omitempty"`
}

// WhoCanResult answers a WhoCanRequest.
type WhoCanResult struct {
	Request  WhoCanRequest `json:"request"`
	Group    string        `json:"group"`
	Resource string        `json:"resource"` // plural, with the subresource: "pods/exec"
	Grants   []WhoCanGrant `json:"grants"`
	// Missing lists the RBAC kinds that could not be listed: the answer is
	// incomplete without them.
	Missing []string `json:"missing"`
	// ServiceAccountPods: for each ServiceAccount in the grants, the pods that run as it.
	ServiceAccountPods map[string][]string `json:"serviceAccountPods"`
}

var whoCanVerbs = []string{"get", "list", "watch", "create", "update", "patch", "delete", "exec"}

// WhoCan lists who the cluster's RBAC objects allow to do req.
func (m *Manager) WhoCan(req WhoCanRequest) (WhoCanResult, error) {
	res := WhoCanResult{Request: req, Grants: []WhoCanGrant{}, Missing: []string{}, ServiceAccountPods: map[string][]string{}}
	if !slices.Contains(whoCanVerbs, req.Verb) {
		return res, fmt.Errorf("unknown verb %q", req.Verb)
	}
	c, err := m.conn(req.Cluster)
	if err != nil {
		return res, err
	}
	gvr, namespaced, err := c.resolve(req.Kind)
	if err != nil {
		return res, err
	}
	verb, resource := req.Verb, gvr.Resource
	if verb == "exec" {
		if gvr.Group != "" || gvr.Resource != "pods" {
			return res, fmt.Errorf("exec is a question about pods")
		}
		verb, resource = "create", "pods/exec"
	}
	if !namespaced {
		req.Namespace = ""
	}
	res.Request, res.Group, res.Resource = req, gvr.Group, resource

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	rbac := c.client.RbacV1()
	// failed records a list that failed: a forbidden one makes the answer
	// incomplete (named in Missing); another error is returned if nothing was found.
	var firstErr error
	failed := func(kind string, err error) bool {
		switch {
		case err == nil:
			return false
		case apierrors.IsForbidden(err):
			res.Missing = append(res.Missing, kind)
		case firstErr == nil:
			firstErr = err
		}
		return true
	}
	clusterRoles := map[string]rbacv1.ClusterRole{}
	if list, err := rbac.ClusterRoles().List(ctx, metav1.ListOptions{}); !failed("ClusterRoles", err) {
		for _, r := range list.Items {
			clusterRoles[r.Name] = r
		}
	}
	roles := map[string]rbacv1.Role{}
	if req.Namespace != "" {
		if list, err := rbac.Roles(req.Namespace).List(ctx, metav1.ListOptions{}); !failed("Roles", err) {
			for _, r := range list.Items {
				roles[r.Name] = r
			}
		}
	}
	want := ruleQuery{group: gvr.Group, resource: resource, verb: verb, name: req.Name}

	if list, err := rbac.ClusterRoleBindings().List(ctx, metav1.ListOptions{}); !failed("ClusterRoleBindings", err) {
		for _, b := range list.Items {
			if b.RoleRef.Kind != "ClusterRole" {
				continue
			}
			role, ok := clusterRoles[b.RoleRef.Name]
			if !ok {
				continue
			}
			res.Grants = append(res.Grants, grantsFrom(want, role.Rules, b.Subjects, "ClusterRoleBinding "+b.Name, "ClusterRole "+role.Name, "cluster-wide", "")...)
		}
	}
	if req.Namespace != "" {
		if list, err := rbac.RoleBindings(req.Namespace).List(ctx, metav1.ListOptions{}); !failed("RoleBindings", err) {
			for _, b := range list.Items {
				var rules []rbacv1.PolicyRule
				var roleName string
				switch b.RoleRef.Kind {
				case "ClusterRole":
					r, ok := clusterRoles[b.RoleRef.Name]
					if !ok {
						continue
					}
					rules, roleName = r.Rules, "ClusterRole "+r.Name
				case "Role":
					r, ok := roles[b.RoleRef.Name]
					if !ok {
						continue
					}
					rules, roleName = r.Rules, "Role "+r.Name
				default:
					continue
				}
				res.Grants = append(res.Grants, grantsFrom(want, rules, b.Subjects, "RoleBinding "+b.Name, roleName, req.Namespace, req.Namespace)...)
			}
		}
	}
	if firstErr != nil && len(res.Grants) == 0 {
		return res, firstErr
	}
	sort.SliceStable(res.Grants, func(i, j int) bool {
		a, b := res.Grants[i], res.Grants[j]
		if a.Wide != b.Wide {
			return a.Wide
		}
		if a.Scope != b.Scope {
			return a.Scope == "cluster-wide"
		}
		return a.Subject < b.Subject
	})
	res.ServiceAccountPods = c.serviceAccountPods(res.Grants)
	return res, nil
}

type ruleQuery struct{ group, resource, verb, name string }

// matches reports whether a rule allows the query, and when it allows only
// named objects and the query named none, which.
func (q ruleQuery) matches(r rbacv1.PolicyRule) (ok bool, onlyNames []string) {
	if len(r.NonResourceURLs) > 0 && len(r.Resources) == 0 {
		return false, nil
	}
	if !matchOne(r.APIGroups, q.group) || !matchOne(r.Verbs, q.verb) || !matchResource(r.Resources, q.resource) {
		return false, nil
	}
	if len(r.ResourceNames) == 0 {
		return true, nil
	}
	if q.name != "" {
		return slices.Contains(r.ResourceNames, q.name), nil
	}
	// list, watch and create cannot be limited by name: a rule with names never allows them.
	if q.verb == "list" || q.verb == "watch" || q.verb == "create" {
		return false, nil
	}
	return true, r.ResourceNames
}

func matchOne(list []string, v string) bool {
	return slices.Contains(list, "*") || slices.Contains(list, v)
}

// matchResource: "*" matches everything; "pods/*" matches every subresource
// of pods; "*/exec" matches exec of every kind.
func matchResource(list []string, res string) bool {
	base, sub, hasSub := strings.Cut(res, "/")
	for _, r := range list {
		switch {
		case r == "*" || r == res:
			return true
		case hasSub && r == base+"/*":
			return true
		case hasSub && r == "*/"+sub:
			return true
		}
	}
	return false
}

func grantsFrom(q ruleQuery, rules []rbacv1.PolicyRule, subjects []rbacv1.Subject, binding, role, scope, bindingNS string) []WhoCanGrant {
	var out []WhoCanGrant
	for _, r := range rules {
		ok, names := q.matches(r)
		if !ok {
			continue
		}
		wild := slices.Contains(r.Resources, "*") || slices.Contains(r.Verbs, "*") || slices.Contains(r.APIGroups, "*")
		for _, s := range subjects {
			g := WhoCanGrant{
				SubjectKind: s.Kind, Subject: s.Name, Scope: scope, Binding: binding, Role: role,
				Rule: ruleText(r), RuleYAML: ruleYAML(r), Wide: scope == "cluster-wide" || wild, OnlyNames: names,
			}
			if s.Kind == "ServiceAccount" {
				ns := s.Namespace
				if ns == "" {
					ns = bindingNS
				}
				g.Subject = ns + "/" + s.Name
			}
			out = append(out, g)
		}
		break // one matching rule per binding is enough to grant it
	}
	return out
}

func ruleText(r rbacv1.PolicyRule) string {
	res := strings.Join(r.Resources, ", ")
	if len(r.ResourceNames) > 0 {
		res += " [" + strings.Join(r.ResourceNames, ", ") + "]"
	}
	return res + ": " + strings.Join(r.Verbs, ", ")
}

func ruleYAML(r rbacv1.PolicyRule) string {
	quote := func(xs []string) string {
		q := make([]string, len(xs))
		for i, x := range xs {
			if x == "" || x == "*" {
				q[i] = `"` + x + `"`
			} else {
				q[i] = x
			}
		}
		return "[" + strings.Join(q, ", ") + "]"
	}
	s := "- apiGroups: " + quote(r.APIGroups) + "\n  resources: " + quote(r.Resources) + "\n"
	if len(r.ResourceNames) > 0 {
		s += "  resourceNames: " + quote(r.ResourceNames) + "\n"
	}
	return s + "  verbs: " + quote(r.Verbs)
}

// serviceAccountPods lists, from the pod cache, the pods that run as each
// ServiceAccount in the grants (nothing when pods are not cached).
func (c *clusterConn) serviceAccountPods(grants []WhoCanGrant) map[string][]string {
	out := map[string][]string{}
	if c.pods == nil || !c.started.Load() {
		return out
	}
	for _, g := range grants {
		if g.SubjectKind != "ServiceAccount" {
			continue
		}
		if _, done := out[g.Subject]; done {
			continue
		}
		ns, name, _ := strings.Cut(g.Subject, "/")
		pods, err := c.pods.Pods(ns).List(labels.Everything())
		if err != nil {
			continue
		}
		names := []string{}
		for _, p := range pods {
			sa := p.Spec.ServiceAccountName
			if sa == "" {
				sa = "default"
			}
			if sa == name {
				names = append(names, p.Name)
			}
		}
		sort.Strings(names)
		out[g.Subject] = names
	}
	return out
}
