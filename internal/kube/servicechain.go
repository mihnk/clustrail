package kube

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// The path a request takes, Ingress → Service → EndpointSlices → Pods, read
// from the objects (nothing is sent to the application), with the first link
// that would make the ingress controller answer 503 or 404.

type ChainCheck struct {
	// Status: ok · warning · error · info.
	Status string `json:"status"`
	// Text is Template with Args filled in ({v0}, {v1}…); the UI translates Template.
	Text     string   `json:"text"`
	Template string   `json:"template"`
	Args     []string `json:"args,omitempty"`
	// Hint is advice (HintTemplate set, translated) or data (pod names, event messages).
	Hint         string   `json:"hint,omitempty"`
	HintTemplate string   `json:"hintTemplate,omitempty"`
	HintArgs     []string `json:"hintArgs,omitempty"`
}

// text is a message with {v0}, {v1}… placeholders; data() is text that is not translated.
type text struct {
	tpl  string
	args []string
	raw  bool
}

func msg(tpl string, args ...any) text {
	t := text{tpl: tpl}
	for _, a := range args {
		t.args = append(t.args, fmt.Sprint(a))
	}
	return t
}

func data(s string) text { return text{tpl: s, raw: true} }

func (t text) String() string {
	out := t.tpl
	for i, a := range t.args {
		out = strings.ReplaceAll(out, fmt.Sprintf("{v%d}", i), a)
	}
	return out
}

type ChainRoute struct {
	Host    string `json:"host"`
	Path    string `json:"path"`
	Service string `json:"service"`
	Port    string `json:"port"`
}

type ChainTLS struct {
	Secret   string   `json:"secret"`
	Hosts    []string `json:"hosts"`
	Found    bool     `json:"found"`
	DaysLeft *int     `json:"daysLeft,omitempty"`
}

type ChainIngress struct {
	Name       string `json:"name"`
	Class      string `json:"class,omitempty"`
	Controller string `json:"controller,omitempty"`
	// ControllerPods counts the controller's ready pods; -1 when they could not be found.
	ControllerPods int          `json:"controllerPods"`
	Routes         []ChainRoute `json:"routes"`
	TLS            []ChainTLS   `json:"tls"`
	Address        []string     `json:"address"`
}

type ChainPort struct {
	Name       string `json:"name,omitempty"`
	Port       int32  `json:"port"`
	TargetPort string `json:"targetPort"`
	Protocol   string `json:"protocol"`
}

type ChainPod struct {
	Name   string `json:"name"`
	Phase  string `json:"phase"`
	Ready  bool   `json:"ready"`
	IP     string `json:"ip,omitempty"`
	Node   string `json:"node,omitempty"`
	Reason string `json:"reason,omitempty"`
}

type ChainService struct {
	Name      string      `json:"name"`
	Found     bool        `json:"found"`
	Type      string      `json:"type,omitempty"`
	ClusterIP string      `json:"clusterIP,omitempty"`
	External  string      `json:"external,omitempty"`
	Selector  string      `json:"selector"`
	Ports     []ChainPort `json:"ports"`
	// Endpoints from the EndpointSlices.
	Ready    []string   `json:"ready"`
	NotReady []string   `json:"notReady"`
	Pods     []ChainPod `json:"pods"`
	// Ingresses in the namespace that route to this Service (Service mode).
	Ingresses []string `json:"ingresses"`
}

type ServiceChain struct {
	Cluster   string         `json:"cluster"`
	Namespace string         `json:"namespace"`
	Ingress   *ChainIngress  `json:"ingress,omitempty"`
	Services  []ChainService `json:"services"`
	Checks    []ChainCheck   `json:"checks"`
	Verdict   ChainCheck     `json:"verdict"`
}

// Ingress controllers whose pods can be found by a well-known label.
var controllerPods = map[string]string{
	"k8s.io/ingress-nginx":                 "app.kubernetes.io/name=ingress-nginx",
	"traefik.io/ingress-controller":        "app.kubernetes.io/name=traefik",
	"ingress.k8s.aws/alb":                  "app.kubernetes.io/name=aws-load-balancer-controller",
	"haproxy.org/ingress-controller":       "app.kubernetes.io/name=kubernetes-ingress",
	"projectcontour.io/ingress-controller": "app.kubernetes.io/name=contour",
}

type chainBuilder struct {
	c      *clusterConn
	ctx    context.Context
	ns     string
	out    *ServiceChain
	netpol *netpolData
}

func (b *chainBuilder) add(status string, t, hint text) {
	ch := ChainCheck{Status: status, Text: t.String(), Template: t.tpl, Args: t.args, Hint: hint.String()}
	if !hint.raw && hint.tpl != "" {
		ch.HintTemplate, ch.HintArgs = hint.tpl, hint.args
	}
	b.out.Checks = append(b.out.Checks, ch)
}

// ServiceChain explains the path to a Service or through an Ingress (kind "Ingress" or "Service").
func (m *Manager) ServiceChain(cluster, ns, kind, name string) (ServiceChain, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return ServiceChain{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out := ServiceChain{Cluster: cluster, Namespace: ns, Services: []ChainService{}, Checks: []ChainCheck{}}
	b := &chainBuilder{c: c, ctx: ctx, ns: ns, out: &out}
	var controllers []*corev1.Pod

	switch kind {
	case "Ingress", "networking.k8s.io/Ingress":
		ing, err := c.client.NetworkingV1().Ingresses(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return out, err
		}
		var backends []ChainRoute
		out.Ingress, backends, controllers = b.ingress(ing)
		seen := map[string]bool{}
		for _, r := range backends {
			if r.Service == "" || seen[r.Service] {
				continue
			}
			seen[r.Service] = true
			out.Services = append(out.Services, b.service(r.Service, backendPorts(backends, r.Service)))
		}
		if len(seen) == 0 {
			b.add("error", msg("ingress/{v0} routes to no Service", name), msg("every rule needs a backend.service"))
		}
	default:
		svc := b.service(name, nil)
		svc.Ingresses = b.ingressesFor(name)
		out.Services = append(out.Services, svc)
	}

	// Network policies between the controller and the backend pods.
	if len(controllers) > 0 {
		for _, s := range out.Services {
			b.policyCheck(controllers[0], s)
		}
	}
	out.Verdict = verdict(out.Checks)
	return out, nil
}

func backendPorts(routes []ChainRoute, svc string) []string {
	var ports []string
	for _, r := range routes {
		if r.Service == svc && !contains(ports, r.Port) {
			ports = append(ports, r.Port)
		}
	}
	return ports
}

func verdict(checks []ChainCheck) ChainCheck {
	for _, want := range []string{"error", "warning"} {
		for _, ch := range checks {
			if ch.Status == want {
				return ch
			}
		}
	}
	hint := "if it still answers 503, the application or the ingress controller's own configuration does"
	return ChainCheck{Status: "ok", Text: "Every link looks right", Template: "Every link looks right", Hint: hint, HintTemplate: hint}
}

func portText(p networkingv1.ServiceBackendPort) string {
	if p.Name != "" {
		return p.Name
	}
	return fmt.Sprint(p.Number)
}

func (b *chainBuilder) ingress(ing *networkingv1.Ingress) (*ChainIngress, []ChainRoute, []*corev1.Pod) {
	ci := &ChainIngress{Name: ing.Name, Routes: []ChainRoute{}, TLS: []ChainTLS{}, Address: []string{}, ControllerPods: -1}
	for _, lb := range ing.Status.LoadBalancer.Ingress {
		if lb.IP != "" {
			ci.Address = append(ci.Address, lb.IP)
		} else if lb.Hostname != "" {
			ci.Address = append(ci.Address, lb.Hostname)
		}
	}
	// Class: spec, the legacy annotation, or the cluster's default IngressClass.
	class := ""
	if ing.Spec.IngressClassName != nil {
		class = *ing.Spec.IngressClassName
	} else if a := ing.Annotations["kubernetes.io/ingress.class"]; a != "" {
		class = a
	}
	var controllers []*corev1.Pod
	classes, err := b.c.client.NetworkingV1().IngressClasses().List(b.ctx, metav1.ListOptions{})
	switch {
	case err != nil:
		b.add("info", msg("IngressClasses could not be read"), data(errorReason(err)))
	default:
		var found *networkingv1.IngressClass
		for i := range classes.Items {
			ic := &classes.Items[i]
			if (class != "" && ic.Name == class) || (class == "" && ic.Annotations["ingressclass.kubernetes.io/is-default-class"] == "true") {
				found = ic
				break
			}
		}
		switch {
		case found == nil && class == "":
			b.add("error", msg("The Ingress names no class and the cluster has no default IngressClass"), msg("no controller picks it up: set spec.ingressClassName"))
		case found == nil:
			b.add("error", msg("IngressClass {v0} does not exist", class), msg("no controller picks this Ingress up"))
		default:
			ci.Class, ci.Controller = found.Name, found.Spec.Controller
			controllers = b.controllerPods(ci)
		}
	}

	add := func(host, path string, be *networkingv1.IngressBackend) {
		r := ChainRoute{Host: host, Path: path}
		if be != nil && be.Service != nil {
			r.Service, r.Port = be.Service.Name, portText(be.Service.Port)
		} else if be != nil && be.Resource != nil {
			r.Service = ""
			r.Port = be.Resource.Kind + "/" + be.Resource.Name
		}
		ci.Routes = append(ci.Routes, r)
	}
	if ing.Spec.DefaultBackend != nil {
		add("*", "(default backend)", ing.Spec.DefaultBackend)
	}
	for _, rule := range ing.Spec.Rules {
		host := rule.Host
		if host == "" {
			host = "*"
		}
		if rule.HTTP == nil {
			continue
		}
		for _, p := range rule.HTTP.Paths {
			path := p.Path
			if path == "" {
				path = "/"
			}
			add(host, path, &p.Backend)
		}
	}
	for _, t := range ing.Spec.TLS {
		tls := ChainTLS{Secret: t.SecretName, Hosts: t.Hosts}
		if t.SecretName == "" {
			ci.TLS = append(ci.TLS, tls)
			continue
		}
		sec, err := b.c.client.CoreV1().Secrets(b.ns).Get(b.ctx, t.SecretName, metav1.GetOptions{})
		switch {
		case apierrors.IsNotFound(err):
			b.add("error", msg("TLS Secret {v0} does not exist", t.SecretName), msg("the controller serves its default certificate for {v0}", strings.Join(t.Hosts, ", ")))
		case err != nil:
			b.add("info", msg("TLS Secret {v0} could not be read", t.SecretName), data(errorReason(err)))
		default:
			tls.Found = true
			if cert := firstCert(sec.Data[corev1.TLSCertKey]); cert != nil {
				d := daysLeft(cert.NotAfter, time.Now())
				tls.DaysLeft = &d
				if d < 0 {
					b.add("error", msg("The certificate in {v0} expired {v1} days ago", t.SecretName, -d), text{})
				} else if d < 14 {
					b.add("warning", msg("The certificate in {v0} expires in {v1} days", t.SecretName, d), text{})
				}
			} else {
				b.add("warning", msg("TLS Secret {v0} holds no certificate", t.SecretName), msg("type {v0}", string(sec.Type)))
			}
		}
		ci.TLS = append(ci.TLS, tls)
	}
	if len(ci.Address) == 0 {
		b.add("warning", msg("The Ingress has no address yet"), msg("the controller has not admitted it, or its load balancer is still being created"))
	}
	return ci, ci.Routes, controllers
}

func (b *chainBuilder) controllerPods(ci *ChainIngress) []*corev1.Pod {
	sel, ok := controllerPods[ci.Controller]
	if !ok {
		b.add("info", msg("IngressClass {v0} uses {v1}", ci.Class, ci.Controller), msg("a controller Clustrail does not look up; its pods are not checked"))
		return nil
	}
	pods, err := b.c.client.CoreV1().Pods("").List(b.ctx, metav1.ListOptions{LabelSelector: sel})
	if err != nil {
		b.add("info", msg("The ingress controller's pods could not be listed"), data(errorReason(err)))
		return nil
	}
	var ready []*corev1.Pod
	for i := range pods.Items {
		if podReady(&pods.Items[i]) {
			ready = append(ready, &pods.Items[i])
		}
	}
	ci.ControllerPods = len(ready)
	switch {
	case len(pods.Items) == 0 && ci.Controller == "ingress.k8s.aws/alb":
		b.add("warning", msg("The AWS Load Balancer Controller has no pods"), msg("nothing reconciles this Ingress"))
	case len(pods.Items) == 0:
		b.add("error", msg("IngressClass {v0} exists but its controller has no pods ({v1})", ci.Class, sel), msg("nothing serves this Ingress"))
	case len(ready) == 0:
		b.add("error", msg("The ingress controller has {v0} pods and none is ready", len(pods.Items)), data(pods.Items[0].Namespace+"/"+pods.Items[0].Name))
	default:
		m := msg("IngressClass {v0} exists and its controller has {v1} ready pods", ci.Class, len(ready))
		if len(ready) == 1 {
			m = msg("IngressClass {v0} exists and its controller has 1 ready pod", ci.Class)
		}
		b.add("ok", m, data(ready[0].Namespace+"/"+ready[0].Name))
	}
	if ci.Controller == "ingress.k8s.aws/alb" {
		// The ALB sends traffic to pod IPs or node ports from outside the cluster: no controller pod is on the path.
		return nil
	}
	return ready
}

func (b *chainBuilder) ingressesFor(svc string) []string {
	out := []string{}
	list, err := b.c.client.NetworkingV1().Ingresses(b.ns).List(b.ctx, metav1.ListOptions{})
	if err != nil {
		return out
	}
	for _, ing := range list.Items {
		refs := false
		if be := ing.Spec.DefaultBackend; be != nil && be.Service != nil && be.Service.Name == svc {
			refs = true
		}
		for _, r := range ing.Spec.Rules {
			if r.HTTP == nil {
				continue
			}
			for _, p := range r.HTTP.Paths {
				if p.Backend.Service != nil && p.Backend.Service.Name == svc {
					refs = true
				}
			}
		}
		if refs {
			out = append(out, ing.Name)
		}
	}
	sort.Strings(out)
	return out
}

// service checks one Service: that it exists, has the ports the Ingress asks
// for, selects pods, and has ready endpoints on a port the pods declare.
func (b *chainBuilder) service(name string, wantPorts []string) ChainService {
	cs := ChainService{Name: name, Ports: []ChainPort{}, Ready: []string{}, NotReady: []string{}, Pods: []ChainPod{}, Ingresses: []string{}}
	svc, err := b.c.client.CoreV1().Services(b.ns).Get(b.ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		b.add("error", msg("service/{v0} does not exist", name), msg("the ingress controller answers 503 for its routes"))
		return cs
	}
	if err != nil {
		b.add("error", msg("service/{v0} could not be read", name), data(errorReason(err)))
		return cs
	}
	cs.Found, cs.Type, cs.ClusterIP = true, string(svc.Spec.Type), svc.Spec.ClusterIP
	for _, p := range svc.Spec.Ports {
		cs.Ports = append(cs.Ports, ChainPort{Name: p.Name, Port: p.Port, TargetPort: p.TargetPort.String(), Protocol: string(p.Protocol)})
	}
	if svc.Spec.Type == corev1.ServiceTypeExternalName {
		cs.External = svc.Spec.ExternalName
		b.add("info", msg("service/{v0} is an ExternalName for {v1}", name, svc.Spec.ExternalName), msg("traffic leaves the cluster; there are no endpoints to check"))
		return cs
	}
	if svc.Spec.Type == corev1.ServiceTypeLoadBalancer && len(svc.Status.LoadBalancer.Ingress) == 0 {
		b.add("warning", msg("service/{v0} is a LoadBalancer without an address yet", name), msg("the cloud load balancer is pending"))
	}

	// The ports the Ingress names must exist on the Service.
	var used []corev1.ServicePort
	for _, want := range wantPorts {
		var match *corev1.ServicePort
		for i, p := range svc.Spec.Ports {
			if p.Name == want || fmt.Sprint(p.Port) == want {
				match = &svc.Spec.Ports[i]
			}
		}
		if match == nil {
			b.add("error", msg("The Ingress routes to {v0}:{v1} but the Service has no such port", name, want), msg("ports: {v0}", servicePortList(svc)))
			continue
		}
		used = append(used, *match)
		b.add("ok", msg("Ingress backend {v0}:{v1} resolves to Service port {v2}", name, want, match.Port), text{})
	}
	if wantPorts == nil {
		used = svc.Spec.Ports
	}

	sel := labels.SelectorFromSet(svc.Spec.Selector)
	cs.Selector = sel.String()
	var pods []corev1.Pod
	if len(svc.Spec.Selector) == 0 {
		b.add("info", msg("service/{v0} has no selector", name), msg("its endpoints are managed by hand or by a controller"))
	} else if list, err := b.c.client.CoreV1().Pods(b.ns).List(b.ctx, metav1.ListOptions{LabelSelector: cs.Selector}); err != nil {
		b.add("info", msg("Pods could not be listed"), data(errorReason(err)))
	} else {
		pods = list.Items
		if len(pods) == 0 {
			b.add("error", msg("Selector {v0} matches no pods", cs.Selector), b.nearMiss(svc.Spec.Selector))
		} else {
			m := msg("Selector {v0} matches {v1} pods", cs.Selector, len(pods))
			if len(pods) == 1 {
				m = msg("Selector {v0} matches 1 pod", cs.Selector)
			}
			b.add("ok", m, text{})
		}
	}
	for i := range pods {
		cs.Pods = append(cs.Pods, b.podView(&pods[i]))
	}
	for _, p := range used {
		b.targetPortCheck(p, pods)
	}

	b.endpoints(&cs)
	switch {
	case len(svc.Spec.Selector) == 0 && len(cs.Ready)+len(cs.NotReady) == 0:
		b.add("error", msg("service/{v0} has no endpoints", name), msg("nothing to route to"))
	case len(cs.Ready) == 0 && len(cs.NotReady) > 0:
		b.add("error", msg("service/{v0} has no ready endpoints", name), data(b.notReadyHint(cs.Pods)))
	case len(cs.Ready) == 0 && len(pods) > 0:
		b.add("error", msg("service/{v0} has no ready endpoints", name), data(b.notReadyHint(cs.Pods)))
	case len(cs.NotReady) > 0:
		b.add("warning", msg("service/{v0}: {v1} ready, {v2} not ready endpoints", name, len(cs.Ready), len(cs.NotReady)), data(b.notReadyHint(cs.Pods)))
	case len(cs.Ready) > 0:
		b.add("ok", msg("service/{v0} has {v1} ready endpoints", name, len(cs.Ready)), text{})
	}
	return cs
}

func servicePortList(svc *corev1.Service) string {
	parts := make([]string, 0, len(svc.Spec.Ports))
	for _, p := range svc.Spec.Ports {
		if p.Name != "" {
			parts = append(parts, fmt.Sprintf("%s %d", p.Name, p.Port))
		} else {
			parts = append(parts, fmt.Sprint(p.Port))
		}
	}
	return strings.Join(parts, ", ")
}

// nearMiss names pods that carry the selector's keys with other values: the usual typo.
func (b *chainBuilder) nearMiss(selector map[string]string) text {
	list, err := b.c.client.CoreV1().Pods(b.ns).List(b.ctx, metav1.ListOptions{})
	if err != nil {
		return text{}
	}
	seen := map[string]bool{}
	var hints []string
	for _, p := range list.Items {
		for k, want := range selector {
			if got, ok := p.Labels[k]; ok && got != want && !seen[k+"="+got] {
				seen[k+"="+got] = true
				hints = append(hints, fmt.Sprintf("%s=%s", k, got))
			}
		}
	}
	if len(hints) == 0 {
		return msg("no pod in {v0} has these label keys", b.ns)
	}
	sort.Strings(hints)
	if len(hints) > 4 {
		hints = hints[:4]
	}
	return msg("pods here have {v0}", strings.Join(hints, ", "))
}

func (b *chainBuilder) targetPortCheck(p corev1.ServicePort, pods []corev1.Pod) {
	if len(pods) == 0 {
		return
	}
	tp := p.TargetPort
	if tp.Type == intstr.Int && tp.IntVal == 0 {
		tp = intstr.FromInt32(p.Port)
	}
	declared := 0
	for i := range pods {
		for _, ct := range pods[i].Spec.Containers {
			for _, cp := range ct.Ports {
				if (tp.Type == intstr.String && cp.Name == tp.StrVal) || (tp.Type == intstr.Int && cp.ContainerPort == tp.IntVal) {
					declared++
				}
			}
		}
	}
	switch {
	case tp.Type == intstr.String && declared == 0:
		b.add("error", msg("targetPort {v0} is not a named port on the selected pods", tp.StrVal), msg("the endpoints get no port: name a containerPort {v0} or use a number", tp.StrVal))
	case tp.Type == intstr.Int && declared == 0:
		b.add("warning", msg("targetPort {v0} is not declared by any container", tp.IntVal), msg("it still works if the process listens there; check the container's port"))
	default:
		b.add("ok", msg("targetPort {v0} is declared by the pods", tp.String()), text{})
	}
}

func (b *chainBuilder) podView(p *corev1.Pod) ChainPod {
	v := ChainPod{Name: p.Name, Phase: string(p.Status.Phase), Ready: podReady(p), IP: p.Status.PodIP, Node: p.Spec.NodeName}
	if v.Ready {
		return v
	}
	for _, cs := range p.Status.ContainerStatuses {
		if w := cs.State.Waiting; w != nil {
			v.Reason = cs.Name + ": " + w.Reason
			return v
		}
	}
	for _, cond := range p.Status.Conditions {
		if cond.Type == corev1.PodScheduled && cond.Status != corev1.ConditionTrue {
			v.Reason = "not scheduled: " + cond.Message
			return v
		}
	}
	// Running but not ready: the newest readiness probe failure says why.
	evs, err := b.c.client.CoreV1().Events(p.Namespace).List(b.ctx, metav1.ListOptions{FieldSelector: "involvedObject.kind=Pod,involvedObject.name=" + p.Name + ",reason=Unhealthy"})
	if err == nil && len(evs.Items) > 0 {
		sort.Slice(evs.Items, func(i, j int) bool { return lastSeen(evs.Items[i]).After(lastSeen(evs.Items[j])) })
		v.Reason = strings.TrimSpace(evs.Items[0].Message)
		return v
	}
	v.Reason = "not ready"
	return v
}

func (b *chainBuilder) notReadyHint(pods []ChainPod) string {
	for _, p := range pods {
		if !p.Ready && p.Reason != "" {
			return p.Name + ": " + p.Reason
		}
	}
	return ""
}

func (b *chainBuilder) endpoints(cs *ChainService) {
	slices, err := b.c.client.DiscoveryV1().EndpointSlices(b.ns).List(b.ctx, metav1.ListOptions{LabelSelector: discoveryv1.LabelServiceName + "=" + cs.Name})
	if err == nil {
		for _, s := range slices.Items {
			for _, e := range s.Endpoints {
				ready := e.Conditions.Ready == nil || *e.Conditions.Ready
				for _, a := range e.Addresses {
					if ready {
						cs.Ready = append(cs.Ready, a)
					} else {
						cs.NotReady = append(cs.NotReady, a)
					}
				}
			}
		}
		return
	}
	//nolint:staticcheck // Endpoints, for identities that may not read EndpointSlices.
	ep, err := b.c.client.CoreV1().Endpoints(b.ns).Get(b.ctx, cs.Name, metav1.GetOptions{})
	if err != nil {
		return
	}
	for _, s := range ep.Subsets {
		for _, a := range s.Addresses {
			cs.Ready = append(cs.Ready, a.IP)
		}
		for _, a := range s.NotReadyAddresses {
			cs.NotReady = append(cs.NotReady, a.IP)
		}
	}
}

// policyCheck says whether network policies let the controller reach the backend pods.
func (b *chainBuilder) policyCheck(controller *corev1.Pod, cs ChainService) {
	if len(cs.Pods) == 0 || len(cs.Ports) == 0 {
		return
	}
	if b.netpol == nil {
		d, err := loadNetpolData(b.ctx, b.c, b.ns)
		if err != nil {
			return
		}
		b.netpol = &d
	}
	dst, err := b.c.client.CoreV1().Pods(b.ns).Get(b.ctx, cs.Pods[0].Name, metav1.GetOptions{})
	if err != nil {
		return
	}
	port := resolveTargetPort(cs.Ports[0], dst)
	if port == 0 {
		return
	}
	ok, via := evaluate(*b.netpol, dst, true, func(peers []networkingv1.NetworkPolicyPeer, ports []networkingv1.NetworkPolicyPort, policyNS string) bool {
		return portAllowed(ports, port, corev1.ProtocolTCP, dst) && peersAdmit(peers, policyNS, *b.netpol, controller, "")
	})
	if ok {
		b.add("ok", msg("Network policies let the controller reach {v0} on {v1}", cs.Name, port), data(via))
	} else {
		b.add("error", msg("Network policies block the ingress controller from {v0} on {v1}", cs.Name, port), data(via))
	}
}

func resolveTargetPort(p ChainPort, pod *corev1.Pod) int32 {
	tp := intstr.Parse(p.TargetPort)
	if tp.Type == intstr.Int {
		if tp.IntVal == 0 {
			return p.Port
		}
		return tp.IntVal
	}
	for _, ct := range pod.Spec.Containers {
		for _, cp := range ct.Ports {
			if cp.Name == tp.StrVal {
				return cp.ContainerPort
			}
		}
	}
	return 0
}
