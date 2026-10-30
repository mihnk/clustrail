package kube

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/url"
	"os"
	"time"

	authnv1 "k8s.io/api/authentication/v1"
	authzv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

type TestStep struct {
	Name   string `json:"name"`
	Result string `json:"result"` // ok · failed · skipped
	Detail string `json:"detail,omitempty"`
	Ms     *int   `json:"ms,omitempty"`
}

// TestConnection runs DNS → TCP → TLS → authentication → API discovery →
// permissions and stops at the first failure. Nothing is changed on the cluster.
func (m *Manager) TestConnection(id string) ([]TestStep, error) {
	cfg, _, err := m.restConfig(id)
	if cfg != nil {
		cfg.Timeout = 20 * time.Second // every step here is a short request
	}
	if err != nil {
		return nil, err
	}
	steps := []TestStep{{Name: "DNS"}, {Name: "TCP"}, {Name: "TLS"}, {Name: "Authentication"}, {Name: "API discovery"}, {Name: "Permissions"}}
	failAt := func(i int, detail string, ms int) []TestStep {
		steps[i].Result, steps[i].Detail, steps[i].Ms = "failed", detail, &ms
		for k := i + 1; k < len(steps); k++ {
			steps[k].Result, steps[k].Detail = "skipped", "skipped"
		}
		return steps
	}
	ok := func(i int, detail string, start time.Time) {
		ms := int(time.Since(start).Milliseconds())
		steps[i].Result, steps[i].Detail, steps[i].Ms = "ok", detail, &ms
	}

	u, err := url.Parse(cfg.Host)
	if err != nil {
		return failAt(0, err.Error(), 0), nil
	}
	host, port := u.Hostname(), u.Port()
	if port == "" {
		port = "443"
	}
	steps[1].Name = "TCP " + port
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	t := time.Now()
	addrs, err := net.DefaultResolver.LookupHost(ctx, host)
	if err != nil {
		return failAt(0, err.Error(), int(time.Since(t).Milliseconds())), nil
	}
	ok(0, maskIP(addrs[0]), t)

	t = time.Now()
	conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(host, port))
	if err != nil {
		return failAt(1, err.Error(), int(time.Since(t).Milliseconds())), nil
	}
	ok(1, "", t)

	if u.Scheme == "https" {
		t = time.Now()
		tc := &tls.Config{ServerName: orDefault(cfg.TLSClientConfig.ServerName, host), InsecureSkipVerify: cfg.TLSClientConfig.Insecure} //nolint:gosec // mirrors the kubeconfig's own setting
		if pool, err := caPool(cfg.TLSClientConfig.CAData, cfg.TLSClientConfig.CAFile); err == nil && pool != nil {
			tc.RootCAs = pool
		}
		tlsConn := tls.Client(conn, tc)
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			conn.Close()
			return failAt(2, err.Error(), int(time.Since(t).Milliseconds())), nil
		}
		detail := "CA trusted"
		if cfg.TLSClientConfig.Insecure {
			detail = "certificate not verified (insecure-skip-tls-verify)"
		}
		if certs := tlsConn.ConnectionState().PeerCertificates; len(certs) > 0 {
			detail += " · valid to " + certs[0].NotAfter.Format("2006-01-02")
		}
		ok(2, detail, t)
		tlsConn.Close()
	} else {
		conn.Close()
		steps[2].Result, steps[2].Detail = "skipped", "plain HTTP"
	}

	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return failAt(3, err.Error(), 0), nil
	}
	t = time.Now()
	review, err := client.AuthenticationV1().SelfSubjectReviews().Create(ctx, &authnv1.SelfSubjectReview{}, metav1.CreateOptions{})
	if err != nil {
		// Old API servers lack SelfSubjectReview; /version still proves the credentials work.
		if _, verr := client.Discovery().ServerVersion(); verr != nil {
			return failAt(3, err.Error(), int(time.Since(t).Milliseconds())), nil
		}
		ok(3, "credentials accepted", t)
	} else {
		ok(3, shortIdentity(review.Status.UserInfo.Username), t)
	}

	t = time.Now()
	v, err := client.Discovery().ServerVersion()
	if err != nil {
		return failAt(4, err.Error(), int(time.Since(t).Milliseconds())), nil
	}
	groups, err := client.Discovery().ServerGroups()
	if err != nil {
		return failAt(4, err.Error(), int(time.Since(t).Milliseconds())), nil
	}
	ok(4, fmt.Sprintf("%s · %d API groups", v.GitVersion, len(groups.Groups)), t)

	t = time.Now()
	ns := "default"
	rules, err := client.AuthorizationV1().SelfSubjectRulesReviews().Create(ctx, &authzv1.SelfSubjectRulesReview{Spec: authzv1.SelfSubjectRulesReviewSpec{Namespace: ns}}, metav1.CreateOptions{})
	if err != nil {
		return failAt(5, err.Error(), int(time.Since(t).Milliseconds())), nil
	}
	ok(5, fmt.Sprintf("%d rules in %s (SelfSubjectRulesReview)", len(rules.Status.ResourceRules), ns), t)
	return steps, nil
}

func caPool(data []byte, file string) (*x509.CertPool, error) {
	if len(data) == 0 && file != "" {
		b, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		data = b
	}
	if len(data) == 0 {
		return nil, nil
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(data)
	return pool, nil
}

// maskIP shows enough of an address to recognize it: 34.91.x.x.
func maskIP(ip string) string {
	parsed := net.ParseIP(ip)
	if v4 := parsed.To4(); v4 != nil && !v4.IsLoopback() && !v4.IsPrivate() {
		return fmt.Sprintf("%d.%d.x.x", v4[0], v4[1])
	}
	return ip
}
