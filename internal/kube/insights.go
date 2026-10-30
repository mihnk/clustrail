package kube

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	authnv1 "k8s.io/api/authentication/v1"
	authzv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/rest"
)

// Cluster-wide checks: Warning events, what an identity may do, and
// certificates and tokens that are about to expire.

// WarningEvent is one Warning event (a repeated event is one entry with its count).
type WarningEvent struct {
	Namespace string `json:"namespace,omitempty"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Reason    string `json:"reason"`
	Message   string `json:"message"`
	Count     int32  `json:"count"`
	FirstSeen string `json:"firstSeen,omitempty"`
	LastSeen  string `json:"lastSeen"`
	Source    string `json:"source,omitempty"`
}

// WarningList is a cluster's Warning events, newest first. Scope is "" when
// they were read cluster-wide, else the one namespace RBAC allowed.
type WarningList struct {
	Cluster string         `json:"cluster"`
	Scope   string         `json:"scope"`
	Events  []WarningEvent `json:"events"`
}

// ClusterWarnings lists Warning events seen in the last sinceSec seconds (0: all
// the API server still keeps, about an hour by default).
func (m *Manager) ClusterWarnings(cluster string, sinceSec int) (WarningList, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return WarningList{}, err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	out := WarningList{Cluster: cluster, Events: []WarningEvent{}}
	opts := metav1.ListOptions{FieldSelector: "type=Warning"}
	evs, err := c.client.CoreV1().Events("").List(ctx, opts)
	if apierrors.IsForbidden(err) && c.fallbackNS != "" {
		out.Scope = c.fallbackNS
		evs, err = c.client.CoreV1().Events(c.fallbackNS).List(ctx, opts)
	}
	if err != nil {
		return out, err
	}
	out.Events = warningEvents(evs.Items, time.Now(), time.Duration(sinceSec)*time.Second)
	return out, nil
}

// WarningCount counts the Warning events of the last sinceSec seconds, for the
// sidebar badge; only the number leaves the backend.
func (m *Manager) WarningCount(cluster string, sinceSec int) (int, error) {
	l, err := m.ClusterWarnings(cluster, sinceSec)
	return len(l.Events), err
}

func warningEvents(items []corev1.Event, now time.Time, window time.Duration) []WarningEvent {
	out := make([]WarningEvent, 0, len(items))
	sort.Slice(items, func(i, j int) bool { return lastSeen(items[i]).After(lastSeen(items[j])) })
	for _, e := range items {
		seen := lastSeen(e)
		if window > 0 && now.Sub(seen) > window {
			continue
		}
		w := WarningEvent{
			Namespace: e.InvolvedObject.Namespace,
			Kind:      e.InvolvedObject.Kind,
			Name:      e.InvolvedObject.Name,
			Reason:    e.Reason,
			Message:   strings.TrimSpace(e.Message),
			Count:     max(e.Count, 1),
			LastSeen:  seen.UTC().Format(time.RFC3339),
			Source:    e.Source.Component,
		}
		if e.Series != nil {
			w.Count = max(e.Series.Count, w.Count)
		}
		if !e.FirstTimestamp.IsZero() {
			w.FirstSeen = e.FirstTimestamp.UTC().Format(time.RFC3339)
		}
		if w.Source == "" {
			w.Source = e.ReportingController
		}
		out = append(out, w)
	}
	return out
}

// AccessSubject is who an access check is about. Kind "" (or "Self") is the
// kubeconfig's own identity; else User, Group or ServiceAccount.
type AccessSubject struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
}

type AccessResource struct {
	Group       string `json:"group"`
	Resource    string `json:"resource"`
	Subresource string `json:"subresource,omitempty"`
	Label       string `json:"label"`
	Namespaced  bool   `json:"namespaced"`
}

// AccessRows are the resources the access check covers, in display order.
var AccessRows = []AccessResource{
	{"", "pods", "", "pods", true},
	{"", "pods", "log", "pods/log", true},
	{"", "pods", "exec", "pods/exec", true},
	{"", "pods", "portforward", "pods/portforward", true},
	{"apps", "deployments", "", "deployments", true},
	{"apps", "statefulsets", "", "statefulsets", true},
	{"apps", "daemonsets", "", "daemonsets", true},
	{"batch", "jobs", "", "jobs", true},
	{"batch", "cronjobs", "", "cronjobs", true},
	{"", "services", "", "services", true},
	{"networking.k8s.io", "ingresses", "", "ingresses", true},
	{"", "configmaps", "", "configmaps", true},
	{"", "secrets", "", "secrets", true},
	{"", "persistentvolumeclaims", "", "persistentvolumeclaims", true},
	{"", "serviceaccounts", "", "serviceaccounts", true},
	{"rbac.authorization.k8s.io", "roles", "", "roles", true},
	{"rbac.authorization.k8s.io", "rolebindings", "", "rolebindings", true},
	{"", "events", "", "events", true},
	{"", "nodes", "", "nodes", false},
	{"", "namespaces", "", "namespaces", false},
	{"", "persistentvolumes", "", "persistentvolumes", false},
	{"rbac.authorization.k8s.io", "clusterroles", "", "clusterroles", false},
	{"apiextensions.k8s.io", "customresourcedefinitions", "", "customresourcedefinitions", false},
}

// AccessVerbs are the matrix columns. Subresources only use "create" or "get".
var AccessVerbs = []string{"get", "list", "watch", "create", "update", "patch", "delete"}

// AccessBinding is a RoleBinding or ClusterRoleBinding that names the subject.
type AccessBinding struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
	Role      string `json:"role"`
	Via       string `json:"via"`
}

type AccessResult struct {
	Subject   AccessSubject    `json:"subject"`
	User      string           `json:"user"`
	Groups    []string         `json:"groups"`
	Namespace string           `json:"namespace"`
	Verbs     []string         `json:"verbs"`
	Resources []AccessResource `json:"resources"`
	// Allowed[i][j] is resource i, verb j: "yes", "no", "n/a" or "error".
	Allowed  [][]string      `json:"allowed"`
	Bindings []AccessBinding `json:"bindings"`
	// BindingsNote says why bindings could not be read, if they could not.
	BindingsNote string `json:"bindingsNote,omitempty"`
}

// subresourceVerbs: the verbs kubectl uses on each subresource.
var subresourceVerbs = map[string][]string{"log": {"get"}, "exec": {"create", "get"}, "portforward": {"create", "get"}}

// AccessMatrix checks what the subject may do in namespace (cluster-scoped
// resources are checked cluster-wide) with SubjectAccessReviews, or
// SelfSubjectAccessReviews for the kubeconfig's own identity. Reviewing someone
// else needs permission to create subjectaccessreviews.
func (m *Manager) AccessMatrix(cluster string, subject AccessSubject, namespace string) (AccessResult, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return AccessResult{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	self := subject.Kind == "" || subject.Kind == "Self"
	res := AccessResult{Subject: subject, Namespace: namespace, Verbs: AccessVerbs, Resources: AccessRows, Groups: []string{}, Bindings: []AccessBinding{}}
	var user string
	var groups []string
	switch {
	case self:
		if r, err := c.client.AuthenticationV1().SelfSubjectReviews().Create(ctx, &authnv1.SelfSubjectReview{}, metav1.CreateOptions{}); err == nil {
			user, groups = r.Status.UserInfo.Username, r.Status.UserInfo.Groups
		}
	case subject.Kind == "User":
		user = subject.Name
	case subject.Kind == "Group":
		groups = []string{subject.Name}
	case subject.Kind == "ServiceAccount":
		if subject.Namespace == "" {
			return res, fmt.Errorf("a ServiceAccount needs its namespace")
		}
		user = "system:serviceaccount:" + subject.Namespace + ":" + subject.Name
		groups = []string{"system:serviceaccounts", "system:serviceaccounts:" + subject.Namespace, "system:authenticated"}
	default:
		return res, fmt.Errorf("unknown subject kind %q", subject.Kind)
	}
	res.User, res.Groups = user, append([]string{}, groups...)

	res.Allowed = make([][]string, len(AccessRows))
	type cell struct{ i, j int }
	var cells []cell
	for i, r := range AccessRows {
		res.Allowed[i] = make([]string, len(AccessVerbs))
		for j, v := range AccessVerbs {
			res.Allowed[i][j] = "n/a"
			if r.Subresource != "" && !contains(subresourceVerbs[r.Subresource], v) {
				continue
			}
			cells = append(cells, cell{i, j})
		}
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error
	sem := make(chan struct{}, 16)
	review := func(attrs *authzv1.ResourceAttributes) (bool, error) {
		if self {
			out, err := c.client.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, &authzv1.SelfSubjectAccessReview{Spec: authzv1.SelfSubjectAccessReviewSpec{ResourceAttributes: attrs}}, metav1.CreateOptions{})
			return err == nil && out.Status.Allowed, err
		}
		out, err := c.client.AuthorizationV1().SubjectAccessReviews().Create(ctx, &authzv1.SubjectAccessReview{Spec: authzv1.SubjectAccessReviewSpec{User: user, Groups: groups, ResourceAttributes: attrs}}, metav1.CreateOptions{})
		return err == nil && out.Status.Allowed, err
	}
	// One review first: without permission to create reviews, every cell would be the same 403.
	if _, err := review(&authzv1.ResourceAttributes{Verb: "get", Resource: "pods", Namespace: namespace}); apierrors.IsForbidden(err) {
		if self {
			return res, err
		}
		return res, fmt.Errorf("checking another identity needs permission to create subjectaccessreviews: %w", err)
	}
	for _, cl := range cells {
		wg.Add(1)
		sem <- struct{}{}
		go func(cl cell) {
			defer func() { <-sem; wg.Done() }()
			r := AccessRows[cl.i]
			attrs := &authzv1.ResourceAttributes{Verb: AccessVerbs[cl.j], Group: r.Group, Resource: r.Resource, Subresource: r.Subresource}
			if r.Namespaced {
				attrs.Namespace = namespace
			}
			allowed, err := review(attrs)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err != nil:
				res.Allowed[cl.i][cl.j] = "error"
				if firstErr == nil {
					firstErr = err
				}
			case allowed:
				res.Allowed[cl.i][cl.j] = "yes"
			default:
				res.Allowed[cl.i][cl.j] = "no"
			}
		}(cl)
	}
	wg.Wait()
	if firstErr != nil && apierrors.IsForbidden(firstErr) {
		return res, fmt.Errorf("checking another identity needs permission to create subjectaccessreviews: %w", firstErr)
	}

	bindings, note := m.bindingsFor(ctx, c, user, groups, namespace)
	res.Bindings, res.BindingsNote = bindings, note
	return res, firstErr
}

func (m *Manager) bindingsFor(ctx context.Context, c *clusterConn, user string, groups []string, namespace string) ([]AccessBinding, string) {
	out := []AccessBinding{}
	match := func(subjects []rbacv1.Subject) string {
		for _, s := range subjects {
			switch s.Kind {
			case "User":
				if s.Name == user && user != "" {
					return "user " + s.Name
				}
			case "Group":
				if contains(groups, s.Name) {
					return "group " + s.Name
				}
			case "ServiceAccount":
				if user == "system:serviceaccount:"+s.Namespace+":"+s.Name {
					return "service account"
				}
			}
		}
		return ""
	}
	var notes []string
	crbs, err := c.client.RbacV1().ClusterRoleBindings().List(ctx, metav1.ListOptions{})
	if err != nil {
		notes = append(notes, "ClusterRoleBindings: "+errorReason(err))
	} else {
		for _, b := range crbs.Items {
			if via := match(b.Subjects); via != "" {
				out = append(out, AccessBinding{Kind: "ClusterRoleBinding", Name: b.Name, Role: b.RoleRef.Kind + "/" + b.RoleRef.Name, Via: via})
			}
		}
	}
	if namespace != "" {
		rbs, err := c.client.RbacV1().RoleBindings(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			notes = append(notes, "RoleBindings in "+namespace+": "+errorReason(err))
		} else {
			for _, b := range rbs.Items {
				if via := match(b.Subjects); via != "" {
					out = append(out, AccessBinding{Kind: "RoleBinding", Name: b.Name, Namespace: b.Namespace, Role: b.RoleRef.Kind + "/" + b.RoleRef.Name, Via: via})
				}
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Kind < out[j].Kind })
	return out, strings.Join(notes, "; ")
}

func errorReason(err error) string {
	if apierrors.IsForbidden(err) {
		return "not allowed to list"
	}
	return err.Error()
}

// ExpiryItem is a certificate or token with an end date.
type ExpiryItem struct {
	// Source: "kubeconfig" (client certificate or token), "apiserver" (the
	// server's serving certificate) or "secret" (a kubernetes.io/tls Secret).
	Source    string   `json:"source"`
	What      string   `json:"what"`
	Namespace string   `json:"namespace,omitempty"`
	Name      string   `json:"name,omitempty"`
	Subject   string   `json:"subject,omitempty"`
	Issuer    string   `json:"issuer,omitempty"`
	DNSNames  []string `json:"dnsNames,omitempty"`
	NotAfter  string   `json:"notAfter"`
	DaysLeft  int      `json:"daysLeft"`
}

type ExpiryReport struct {
	Cluster string       `json:"cluster"`
	Items   []ExpiryItem `json:"items"`
	// Notes are checks that could not run (no permission, server unreachable).
	Notes []string `json:"notes"`
}

// Expiry reports the kubeconfig credential, the API server certificate and the
// cluster's TLS Secrets with their end dates, soonest first. Secret values never
// leave this function; only the certificate's dates and names do.
func (m *Manager) Expiry(cluster string) (ExpiryReport, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return ExpiryReport{}, err
	}
	now := time.Now()
	out := ExpiryReport{Cluster: cluster, Items: []ExpiryItem{}, Notes: []string{}}
	out.Items = append(out.Items, credentialExpiry(c.rest, now)...)
	if it, err := serverCertExpiry(c.rest, now); err != nil {
		out.Notes = append(out.Notes, "API server certificate: "+err.Error())
	} else if it != nil {
		out.Items = append(out.Items, *it)
	}
	ctx, cancel := actionCtx()
	defer cancel()
	ns := ""
	secrets, err := c.client.CoreV1().Secrets(ns).List(ctx, metav1.ListOptions{FieldSelector: "type=kubernetes.io/tls"})
	if apierrors.IsForbidden(err) && c.fallbackNS != "" {
		ns = c.fallbackNS
		secrets, err = c.client.CoreV1().Secrets(ns).List(ctx, metav1.ListOptions{FieldSelector: "type=kubernetes.io/tls"})
		if err == nil {
			out.Notes = append(out.Notes, "TLS Secrets: only namespace "+ns+" (not allowed to list Secrets cluster-wide)")
		}
	}
	if err != nil {
		out.Notes = append(out.Notes, "TLS Secrets: "+errorReason(err))
	} else {
		out.Items = append(out.Items, secretExpiry(secrets.Items, now)...)
	}
	sort.SliceStable(out.Items, func(i, j int) bool { return out.Items[i].NotAfter < out.Items[j].NotAfter })
	return out, nil
}

func certItem(source, what string, cert *x509.Certificate, now time.Time) ExpiryItem {
	return ExpiryItem{
		Source:   source,
		What:     what,
		Subject:  cert.Subject.CommonName,
		Issuer:   cert.Issuer.CommonName,
		DNSNames: cert.DNSNames,
		NotAfter: cert.NotAfter.UTC().Format(time.RFC3339),
		DaysLeft: daysLeft(cert.NotAfter, now),
	}
}

func daysLeft(t, now time.Time) int {
	d := t.Sub(now)
	if d < 0 {
		return -int((-d).Hours()/24) - 1
	}
	return int(d.Hours() / 24)
}

func firstCert(data []byte) *x509.Certificate {
	for {
		var block *pem.Block
		block, data = pem.Decode(data)
		if block == nil {
			return nil
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		if cert, err := x509.ParseCertificate(block.Bytes); err == nil {
			return cert
		}
	}
}

func credentialExpiry(cfg *rest.Config, now time.Time) []ExpiryItem {
	if cfg == nil {
		return nil
	}
	var out []ExpiryItem
	certData := cfg.TLSClientConfig.CertData
	if len(certData) == 0 && cfg.TLSClientConfig.CertFile != "" {
		certData, _ = os.ReadFile(cfg.TLSClientConfig.CertFile)
	}
	if cert := firstCert(certData); cert != nil {
		out = append(out, certItem("kubeconfig", "Client certificate", cert, now))
	}
	token := cfg.BearerToken
	if token == "" && cfg.BearerTokenFile != "" {
		if b, err := os.ReadFile(cfg.BearerTokenFile); err == nil {
			token = strings.TrimSpace(string(b))
		}
	}
	if exp, sub, ok := jwtExpiry(token); ok {
		out = append(out, ExpiryItem{Source: "kubeconfig", What: "Bearer token", Subject: sub, NotAfter: exp.UTC().Format(time.RFC3339), DaysLeft: daysLeft(exp, now)})
	}
	return out
}

// jwtExpiry reads exp and sub from a JWT without verifying it: the date is
// only shown, never trusted for access.
func jwtExpiry(token string) (time.Time, string, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, "", false
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, "", false
	}
	var claims struct {
		Exp float64 `json:"exp"`
		Sub string  `json:"sub"`
	}
	if json.Unmarshal(body, &claims) != nil || claims.Exp == 0 {
		return time.Time{}, "", false
	}
	return time.Unix(int64(claims.Exp), 0), claims.Sub, true
}

func serverCertExpiry(cfg *rest.Config, now time.Time) (*ExpiryItem, error) {
	if cfg == nil || cfg.Host == "" {
		return nil, nil
	}
	u, err := url.Parse(cfg.Host)
	if err != nil || u.Scheme != "https" {
		return nil, nil
	}
	if cfg.Proxy != nil {
		// A proxied API server is reached through the proxy; the direct dial below would say nothing useful.
		return nil, nil
	}
	host := u.Host
	if u.Port() == "" {
		host = net.JoinHostPort(u.Hostname(), "443")
	}
	tlsCfg, err := rest.TLSConfigFor(cfg)
	if err != nil {
		return nil, err
	}
	if tlsCfg == nil {
		tlsCfg = &tls.Config{}
	}
	// Only the presented certificate's dates are read; verification already
	// happens on every API call, and an expired certificate must still be shown.
	tlsCfg = tlsCfg.Clone()
	tlsCfg.InsecureSkipVerify = true //nolint:gosec // read-only inspection of the peer certificate
	if tlsCfg.ServerName == "" {
		tlsCfg.ServerName = u.Hostname()
	}
	conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp", host, tlsCfg)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return nil, nil
	}
	it := certItem("apiserver", "API server certificate", certs[0], now)
	return &it, nil
}

func secretExpiry(secrets []corev1.Secret, now time.Time) []ExpiryItem {
	var out []ExpiryItem
	for i := range secrets {
		s := &secrets[i]
		cert := firstCert(s.Data[corev1.TLSCertKey])
		if cert == nil {
			continue
		}
		it := certItem("secret", "TLS Secret", cert, now)
		it.Namespace, it.Name = s.Namespace, s.Name
		out = append(out, it)
	}
	return out
}
