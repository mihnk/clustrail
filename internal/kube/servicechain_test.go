package kube

import (
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
)

func chainFixture(mutate func(objs map[string]any)) []any {
	nginx := "nginx"
	prefix := networkingv1.PathTypePrefix
	no := false
	objs := map[string]any{
		"class": &networkingv1.IngressClass{ObjectMeta: metav1.ObjectMeta{Name: "nginx"}, Spec: networkingv1.IngressClassSpec{Controller: "k8s.io/ingress-nginx"}},
		"ctrl": pod("ingress-nginx-controller-abc", func(p *corev1.Pod) {
			p.Namespace = "ingress-nginx"
			p.Labels = map[string]string{"app.kubernetes.io/name": "ingress-nginx"}
			p.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}
		}),
		"ing": &networkingv1.Ingress{
			ObjectMeta: metav1.ObjectMeta{Name: "shop", Namespace: "payments"},
			Spec: networkingv1.IngressSpec{
				IngressClassName: &nginx,
				TLS:              []networkingv1.IngressTLS{{Hosts: []string{"shop.example.com"}, SecretName: "shop-tls"}},
				Rules: []networkingv1.IngressRule{{Host: "shop.example.com", IngressRuleValue: networkingv1.IngressRuleValue{HTTP: &networkingv1.HTTPIngressRuleValue{Paths: []networkingv1.HTTPIngressPath{
					{Path: "/api", PathType: &prefix, Backend: networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{Name: "checkout-api", Port: networkingv1.ServiceBackendPort{Name: "http"}}}},
				}}}}},
			},
			Status: networkingv1.IngressStatus{LoadBalancer: networkingv1.IngressLoadBalancerStatus{Ingress: []networkingv1.IngressLoadBalancerIngress{{IP: "34.120.8.17"}}}},
		},
		"tls": &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "shop-tls", Namespace: "payments"}, Type: corev1.SecretTypeTLS, Data: map[string][]byte{}},
		"svc": &corev1.Service{
			ObjectMeta: metav1.ObjectMeta{Name: "checkout-api", Namespace: "payments"},
			Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeClusterIP, ClusterIP: "10.96.12.4", Selector: map[string]string{"app": "checkout-api"},
				Ports: []corev1.ServicePort{{Name: "http", Port: 80, TargetPort: intstr.FromString("http"), Protocol: corev1.ProtocolTCP}}},
		},
		"pod": pod("checkout-api-1", func(p *corev1.Pod) {
			p.Status.PodIP = "10.1.4.17"
			p.Spec.Containers[0].Ports = []corev1.ContainerPort{{Name: "http", ContainerPort: 8080, Protocol: corev1.ProtocolTCP}}
			p.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionFalse}}
		}),
		"unhealthy": &corev1.Event{ObjectMeta: metav1.ObjectMeta{Name: "u1", Namespace: "payments"}, Reason: "Unhealthy", Type: "Warning", LastTimestamp: metav1.Now(),
			InvolvedObject: corev1.ObjectReference{Kind: "Pod", Name: "checkout-api-1", Namespace: "payments"},
			Message:        "Readiness probe failed: Get \"http://10.1.4.17:8081/healthz\": dial tcp 10.1.4.17:8081: connect: connection refused"},
		"slice": &discoveryv1.EndpointSlice{
			ObjectMeta:  metav1.ObjectMeta{Name: "checkout-api-x7k2p", Namespace: "payments", Labels: map[string]string{discoveryv1.LabelServiceName: "checkout-api"}},
			AddressType: discoveryv1.AddressTypeIPv4,
			Endpoints:   []discoveryv1.Endpoint{{Addresses: []string{"10.1.4.17"}, Conditions: discoveryv1.EndpointConditions{Ready: &no}}},
		},
	}
	if mutate != nil {
		mutate(objs)
	}
	out := []any{}
	for _, o := range objs {
		if o != nil {
			out = append(out, o)
		}
	}
	return out
}

func chainFor(t *testing.T, kind, name string, mutate func(map[string]any)) ServiceChain {
	t.Helper()
	c, _, _ := newFakeConn(t, toRuntime(chainFixture(mutate))...)
	m := managerWith(c, false)
	out, err := m.ServiceChain("test", "payments", kind, name)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func hasCheck(ch ServiceChain, status, text string) bool {
	for _, c := range ch.Checks {
		if c.Status == status && strings.Contains(c.Text, text) {
			return true
		}
	}
	return false
}

func TestServiceChainNoReadyEndpoints(t *testing.T) {
	ch := chainFor(t, "Ingress", "shop", nil)
	if ch.Ingress == nil || ch.Ingress.Class != "nginx" || ch.Ingress.ControllerPods != 1 || len(ch.Ingress.Routes) != 1 || ch.Ingress.Address[0] != "34.120.8.17" {
		t.Fatalf("ingress = %+v", ch.Ingress)
	}
	if !hasCheck(ch, "ok", "controller has 1 ready pods") || !hasCheck(ch, "ok", "resolves to Service port 80") || !hasCheck(ch, "ok", "matches 1 pods") || !hasCheck(ch, "ok", "targetPort http is declared") {
		t.Fatalf("checks = %+v", ch.Checks)
	}
	if !hasCheck(ch, "warning", "shop-tls holds no certificate") {
		t.Fatalf("tls check missing: %+v", ch.Checks)
	}
	if ch.Verdict.Status != "error" || !strings.Contains(ch.Verdict.Text, "no ready endpoints") || !strings.Contains(ch.Verdict.Hint, "8081") {
		t.Fatalf("verdict = %+v", ch.Verdict)
	}
	// The UI translates the template; data (the probe message) is not a template.
	if ch.Verdict.Template != "service/{v0} has no ready endpoints" || len(ch.Verdict.Args) != 1 || ch.Verdict.Args[0] != "checkout-api" || ch.Verdict.HintTemplate != "" {
		t.Fatalf("verdict template = %+v", ch.Verdict)
	}
	s := ch.Services[0]
	if len(s.NotReady) != 1 || len(s.Pods) != 1 || s.Pods[0].Ready || !strings.Contains(s.Pods[0].Reason, "Readiness probe failed") {
		t.Fatalf("service = %+v", s)
	}
}

func TestServiceChainBrokenLinks(t *testing.T) {
	// The selector has a typo: no pod matches, and the hint names the labels that exist.
	ch := chainFor(t, "Service", "checkout-api", func(o map[string]any) {
		o["svc"].(*corev1.Service).Spec.Selector = map[string]string{"app": "checkout"}
		o["slice"] = nil
	})
	if ch.Verdict.Status != "error" || ch.Verdict.Text != "Selector app=checkout matches no pods" || !strings.Contains(ch.Verdict.Hint, "app=checkout-api") {
		t.Fatalf("verdict = %+v", ch.Verdict)
	}
	if len(ch.Services[0].Ingresses) != 1 || ch.Services[0].Ingresses[0] != "shop" {
		t.Fatalf("ingresses routing here = %v", ch.Services[0].Ingresses)
	}

	// The Ingress names a port the Service does not have.
	ch = chainFor(t, "Ingress", "shop", func(o map[string]any) {
		o["ing"].(*networkingv1.Ingress).Spec.Rules[0].HTTP.Paths[0].Backend.Service.Port = networkingv1.ServiceBackendPort{Number: 8443}
	})
	if !hasCheck(ch, "error", "routes to checkout-api:8443 but the Service has no such port") {
		t.Fatalf("checks = %+v", ch.Checks)
	}

	// The Service is missing; the class does not exist.
	ch = chainFor(t, "Ingress", "shop", func(o map[string]any) {
		o["svc"] = nil
		o["class"] = nil
	})
	if ch.Verdict.Text != "IngressClass nginx does not exist" || !hasCheck(ch, "error", "service/checkout-api does not exist") {
		t.Fatalf("verdict = %+v checks = %+v", ch.Verdict, ch.Checks)
	}

	// A named targetPort the pods do not declare.
	ch = chainFor(t, "Service", "checkout-api", func(o map[string]any) {
		o["svc"].(*corev1.Service).Spec.Ports[0].TargetPort = intstr.FromString("web")
	})
	if !hasCheck(ch, "error", "targetPort web is not a named port") {
		t.Fatalf("checks = %+v", ch.Checks)
	}

	// Everything ready: the verdict says so and points past the cluster.
	yes := true
	ch = chainFor(t, "Ingress", "shop", func(o map[string]any) {
		o["slice"].(*discoveryv1.EndpointSlice).Endpoints[0].Conditions.Ready = &yes
		o["pod"].(*corev1.Pod).Status.Conditions[0].Status = corev1.ConditionTrue
		o["tls"].(*corev1.Secret).Data["tls.crt"] = []byte("x")
		o["ing"].(*networkingv1.Ingress).Spec.TLS = nil
	})
	if ch.Verdict.Status != "ok" || !hasCheck(ch, "ok", "1 ready endpoints") {
		t.Fatalf("verdict = %+v checks = %+v", ch.Verdict, ch.Checks)
	}
}

func TestServiceChainNetworkPolicyBlocksController(t *testing.T) {
	ch := chainFor(t, "Ingress", "shop", func(o map[string]any) {
		o["deny"] = &networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: "default-deny", Namespace: "payments"}, Spec: networkingv1.NetworkPolicySpec{PolicyTypes: []networkingv1.PolicyType{"Ingress"}}}
	})
	if !hasCheck(ch, "error", "Network policies block the ingress controller from checkout-api on 8080") {
		t.Fatalf("checks = %+v", ch.Checks)
	}
}
