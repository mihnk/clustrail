package kube

import (
	"context"
	"fmt"
	"net"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// NetworkPolicy, read from the objects: which policies select a pod, what
// each of their rules lets in or out, and whether one pod may reach another.
// Whether the cluster enforces any of it is up to its network plugin.

type NetPolRule struct {
	Policy string `json:"policy"`
	// Rule is the rule's position in the policy, from 1.
	Rule int `json:"rule"`
	// Peers says who in plain words ("Pods app=web in namespaces name=edge").
	Peers string `json:"peers"`
	Ports string `json:"ports"`
	// Pods is how many pods the peers match now (-1: an IP block, not counted).
	Pods int `json:"pods"`
}

type NetPolDirection struct {
	// Isolated: a policy selects the pod for this direction, so only its rules allow traffic.
	Isolated bool         `json:"isolated"`
	Policies []string     `json:"policies"`
	Rules    []NetPolRule `json:"rules"`
}

type NetPolView struct {
	Namespace string            `json:"namespace"`
	Pod       string            `json:"pod"`
	Labels    map[string]string `json:"labels"`
	Ingress   NetPolDirection   `json:"ingress"`
	Egress    NetPolDirection   `json:"egress"`
	// Plugin is the network plugin found in kube-system, and whether it enforces policies.
	Plugin   string `json:"plugin"`
	Enforced string `json:"enforced"` // yes · no · unknown
	// Policies in the namespace, for the list beside the pod.
	All []string `json:"all"`
}

type ConnectionCheck struct {
	Allowed    bool   `json:"allowed"`
	Egress     bool   `json:"egress"`
	EgressVia  string `json:"egressVia"`
	Ingress    bool   `json:"ingress"`
	IngressVia string `json:"ingressVia"`
}

type netpolData struct {
	pods       []*corev1.Pod
	namespaces map[string]map[string]string // name → labels
	policies   []networkingv1.NetworkPolicy
}

func (m *Manager) netpolData(ctx context.Context, c *clusterConn, ns string) (netpolData, error) {
	d := netpolData{namespaces: map[string]map[string]string{}}
	pols, err := c.client.NetworkingV1().NetworkPolicies("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if pols, err = c.client.NetworkingV1().NetworkPolicies(ns).List(ctx, metav1.ListOptions{}); err != nil {
			return d, err
		}
	}
	d.policies = pols.Items
	if nss, err := c.client.CoreV1().Namespaces().List(ctx, metav1.ListOptions{}); err == nil {
		for _, n := range nss.Items {
			d.namespaces[n.Name] = n.Labels
		}
	}
	if c.pods != nil && c.started.Load() && c.podsNS == "" {
		d.pods, _ = c.pods.List(labels.Everything())
	} else if list, err := c.client.CoreV1().Pods("").List(ctx, metav1.ListOptions{}); err == nil {
		for i := range list.Items {
			d.pods = append(d.pods, &list.Items[i])
		}
	} else if list, err := c.client.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range list.Items {
			d.pods = append(d.pods, &list.Items[i])
		}
	}
	return d, nil
}

func nsLabels(d netpolData, ns string) map[string]string {
	if l, ok := d.namespaces[ns]; ok {
		return l
	}
	// Every namespace carries this label (1.21+), even when namespaces cannot be listed.
	return map[string]string{"kubernetes.io/metadata.name": ns}
}

func selectorText(s *metav1.LabelSelector) string {
	if s == nil {
		return ""
	}
	sel, err := metav1.LabelSelectorAsSelector(s)
	if err != nil {
		return "(invalid selector)"
	}
	return sel.String()
}

func policyTypes(p *networkingv1.NetworkPolicy) (ingress, egress bool) {
	if len(p.Spec.PolicyTypes) == 0 {
		return true, len(p.Spec.Egress) > 0
	}
	for _, t := range p.Spec.PolicyTypes {
		switch t {
		case networkingv1.PolicyTypeIngress:
			ingress = true
		case networkingv1.PolicyTypeEgress:
			egress = true
		}
	}
	return
}

func selects(p *networkingv1.NetworkPolicy, pod *corev1.Pod) bool {
	if p.Namespace != pod.Namespace {
		return false
	}
	sel, err := metav1.LabelSelectorAsSelector(&p.Spec.PodSelector)
	return err == nil && sel.Matches(labels.Set(pod.Labels))
}

func peerText(peer networkingv1.NetworkPolicyPeer) string {
	if b := peer.IPBlock; b != nil {
		if len(b.Except) > 0 {
			return b.CIDR + " except " + strings.Join(b.Except, ", ")
		}
		return b.CIDR
	}
	pods, nss := selectorText(peer.PodSelector), selectorText(peer.NamespaceSelector)
	switch {
	case peer.NamespaceSelector == nil:
		if pods == "" {
			return "All pods in this namespace"
		}
		return "Pods " + pods + " in this namespace"
	case peer.PodSelector == nil:
		if nss == "" {
			return "All pods in all namespaces"
		}
		return "All pods in namespaces " + nss
	default:
		who := "All pods"
		if pods != "" {
			who = "Pods " + pods
		}
		if nss == "" {
			return who + " in all namespaces"
		}
		return who + " in namespaces " + nss
	}
}

func portsText(ports []networkingv1.NetworkPolicyPort) string {
	if len(ports) == 0 {
		return "all ports"
	}
	out := make([]string, 0, len(ports))
	for _, p := range ports {
		proto := "TCP"
		if p.Protocol != nil {
			proto = string(*p.Protocol)
		}
		switch {
		case p.Port == nil:
			out = append(out, proto+" all ports")
		case p.EndPort != nil:
			out = append(out, fmt.Sprintf("%s %s-%d", proto, p.Port.String(), *p.EndPort))
		default:
			out = append(out, proto+" "+p.Port.String())
		}
	}
	return strings.Join(out, ", ")
}

// peerMatches says whether a pod (or, with pod nil, an IP) is one of the peer's.
func peerMatches(peer networkingv1.NetworkPolicyPeer, policyNS string, d netpolData, pod *corev1.Pod, ip string) bool {
	if b := peer.IPBlock; b != nil {
		if ip == "" && pod != nil {
			ip = pod.Status.PodIP
		}
		return ipInBlock(ip, b)
	}
	if pod == nil {
		return false
	}
	if peer.NamespaceSelector == nil {
		if pod.Namespace != policyNS {
			return false
		}
	} else {
		nsSel, err := metav1.LabelSelectorAsSelector(peer.NamespaceSelector)
		if err != nil || !nsSel.Matches(labels.Set(nsLabels(d, pod.Namespace))) {
			return false
		}
	}
	if peer.PodSelector == nil {
		return true
	}
	sel, err := metav1.LabelSelectorAsSelector(peer.PodSelector)
	return err == nil && sel.Matches(labels.Set(pod.Labels))
}

func ipInBlock(ip string, b *networkingv1.IPBlock) bool {
	addr := net.ParseIP(ip)
	if addr == nil {
		return false
	}
	_, cidr, err := net.ParseCIDR(b.CIDR)
	if err != nil || !cidr.Contains(addr) {
		return false
	}
	for _, ex := range b.Except {
		if _, n, err := net.ParseCIDR(ex); err == nil && n.Contains(addr) {
			return false
		}
	}
	return true
}

func countPeers(peers []networkingv1.NetworkPolicyPeer, policyNS string, d netpolData) int {
	n := 0
	for _, p := range d.pods {
		for _, peer := range peers {
			if peer.IPBlock != nil {
				return -1
			}
			if peerMatches(peer, policyNS, d, p, "") {
				n++
				break
			}
		}
	}
	return n
}

func direction(pod *corev1.Pod, d netpolData, ingress bool) NetPolDirection {
	out := NetPolDirection{Policies: []string{}, Rules: []NetPolRule{}}
	for i := range d.policies {
		p := &d.policies[i]
		in, eg := policyTypes(p)
		if !selects(p, pod) || (ingress && !in) || (!ingress && !eg) {
			continue
		}
		out.Isolated = true
		out.Policies = append(out.Policies, p.Name)
		if ingress {
			for j, r := range p.Spec.Ingress {
				out.Rules = append(out.Rules, ruleView(p, j, r.From, r.Ports, d))
			}
		} else {
			for j, r := range p.Spec.Egress {
				out.Rules = append(out.Rules, ruleView(p, j, r.To, r.Ports, d))
			}
		}
	}
	return out
}

func ruleView(p *networkingv1.NetworkPolicy, j int, peers []networkingv1.NetworkPolicyPeer, ports []networkingv1.NetworkPolicyPort, d netpolData) NetPolRule {
	r := NetPolRule{Policy: p.Name, Rule: j + 1, Ports: portsText(ports)}
	if len(peers) == 0 {
		r.Peers, r.Pods = "Anyone", -1
		return r
	}
	texts := make([]string, len(peers))
	for i, peer := range peers {
		texts[i] = peerText(peer)
	}
	r.Peers = strings.Join(texts, "; or ")
	r.Pods = countPeers(peers, p.Namespace, d)
	return r
}

// networkPlugin guesses the CNI from kube-system DaemonSets.
func networkPlugin(ctx context.Context, c *clusterConn) (string, string) {
	dss, err := c.client.AppsV1().DaemonSets("kube-system").List(ctx, metav1.ListOptions{})
	if err != nil {
		return "", "unknown"
	}
	names := make([]string, 0, len(dss.Items))
	for _, d := range dss.Items {
		names = append(names, d.Name)
		for _, ct := range d.Spec.Template.Spec.Containers {
			names = append(names, ct.Name)
		}
	}
	has := func(s string) bool {
		for _, n := range names {
			if strings.Contains(n, s) {
				return true
			}
		}
		return false
	}
	switch {
	case has("cilium"):
		return "Cilium", "yes"
	case has("calico"), has("canal"):
		return "Calico", "yes"
	case has("antrea"):
		return "Antrea", "yes"
	case has("weave"):
		return "Weave Net", "yes"
	case has("kube-router"):
		return "kube-router", "yes"
	case has("network-policy-agent"), has("aws-network-policy"):
		return "Amazon VPC CNI with network policy agent", "yes"
	case has("aws-node"):
		return "Amazon VPC CNI", "unknown"
	case has("kindnet"):
		return "kindnet", "yes"
	case has("flannel"):
		return "Flannel", "no"
	}
	return "", "unknown"
}

// PodNetworkPolicies shows what reaches a pod and what it reaches.
func (m *Manager) PodNetworkPolicies(cluster, ns, pod string) (NetPolView, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return NetPolView{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	p, err := c.client.CoreV1().Pods(ns).Get(ctx, pod, metav1.GetOptions{})
	if err != nil {
		return NetPolView{}, err
	}
	d, err := m.netpolData(ctx, c, ns)
	if err != nil {
		return NetPolView{}, err
	}
	v := NetPolView{Namespace: ns, Pod: pod, Labels: p.Labels, Ingress: direction(p, d, true), Egress: direction(p, d, false), All: []string{}}
	if v.Labels == nil {
		v.Labels = map[string]string{}
	}
	for _, pol := range d.policies {
		if pol.Namespace == ns {
			v.All = append(v.All, pol.Name)
		}
	}
	sort.Strings(v.All)
	v.Plugin, v.Enforced = networkPlugin(ctx, c)
	return v, nil
}

// portAllowed says whether a rule's ports admit port/protocol on the destination pod (named ports resolved there).
func portAllowed(ports []networkingv1.NetworkPolicyPort, port int32, proto corev1.Protocol, dst *corev1.Pod) bool {
	if len(ports) == 0 {
		return true
	}
	for _, p := range ports {
		pp := corev1.ProtocolTCP
		if p.Protocol != nil {
			pp = *p.Protocol
		}
		if pp != proto {
			continue
		}
		if p.Port == nil {
			return true
		}
		if p.Port.Type == intstr.String {
			if dst == nil {
				continue
			}
			for _, ct := range dst.Spec.Containers {
				for _, cp := range ct.Ports {
					if cp.Name == p.Port.StrVal && cp.ContainerPort == port && cp.Protocol == pp {
						return true
					}
				}
			}
			continue
		}
		lo, hi := p.Port.IntVal, p.Port.IntVal
		if p.EndPort != nil {
			hi = *p.EndPort
		}
		if port >= lo && port <= hi {
			return true
		}
	}
	return false
}

// CheckConnection says whether policies let a pod open a connection to
// another pod (dst) or to an IP (dstIP), on port/protocol.
func (m *Manager) CheckConnection(cluster, srcNS, srcPod, dstNS, dstPod, dstIP string, port int32, protocol string) (ConnectionCheck, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return ConnectionCheck{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	src, err := c.client.CoreV1().Pods(srcNS).Get(ctx, srcPod, metav1.GetOptions{})
	if err != nil {
		return ConnectionCheck{}, err
	}
	var dst *corev1.Pod
	if dstPod != "" {
		if dst, err = c.client.CoreV1().Pods(dstNS).Get(ctx, dstPod, metav1.GetOptions{}); err != nil {
			return ConnectionCheck{}, err
		}
		dstIP = dst.Status.PodIP
	}
	d, err := m.netpolData(ctx, c, srcNS)
	if err != nil {
		return ConnectionCheck{}, err
	}
	proto := corev1.Protocol(strings.ToUpper(protocol))
	if proto == "" {
		proto = corev1.ProtocolTCP
	}
	out := ConnectionCheck{}
	out.Egress, out.EgressVia = evaluate(d, src, false, func(peers []networkingv1.NetworkPolicyPeer, ports []networkingv1.NetworkPolicyPort, policyNS string) bool {
		return portAllowed(ports, port, proto, dst) && peersAdmit(peers, policyNS, d, dst, dstIP)
	})
	if dst == nil {
		out.Ingress, out.IngressVia = true, "not a pod: no ingress policy applies"
	} else {
		out.Ingress, out.IngressVia = evaluate(d, dst, true, func(peers []networkingv1.NetworkPolicyPeer, ports []networkingv1.NetworkPolicyPort, policyNS string) bool {
			return portAllowed(ports, port, proto, dst) && peersAdmit(peers, policyNS, d, src, "")
		})
	}
	out.Allowed = out.Egress && out.Ingress
	return out, nil
}

func peersAdmit(peers []networkingv1.NetworkPolicyPeer, policyNS string, d netpolData, pod *corev1.Pod, ip string) bool {
	if len(peers) == 0 {
		return true
	}
	for _, peer := range peers {
		if peerMatches(peer, policyNS, d, pod, ip) {
			return true
		}
	}
	return false
}

// evaluate applies the policies selecting pod in one direction: not isolated
// allows everything; isolated allows what any rule allows.
func evaluate(d netpolData, pod *corev1.Pod, ingress bool, admits func([]networkingv1.NetworkPolicyPeer, []networkingv1.NetworkPolicyPort, string) bool) (bool, string) {
	isolatedBy := []string{}
	for i := range d.policies {
		p := &d.policies[i]
		in, eg := policyTypes(p)
		if !selects(p, pod) || (ingress && !in) || (!ingress && !eg) {
			continue
		}
		isolatedBy = append(isolatedBy, p.Name)
		if ingress {
			for j, r := range p.Spec.Ingress {
				if admits(r.From, r.Ports, p.Namespace) {
					return true, fmt.Sprintf("%s rule %d", p.Name, j+1)
				}
			}
		} else {
			for j, r := range p.Spec.Egress {
				if admits(r.To, r.Ports, p.Namespace) {
					return true, fmt.Sprintf("%s rule %d", p.Name, j+1)
				}
			}
		}
	}
	if len(isolatedBy) == 0 {
		return true, "no policy selects the pod"
	}
	return false, "denied: selected by " + strings.Join(isolatedBy, ", ") + " and no rule matches"
}
