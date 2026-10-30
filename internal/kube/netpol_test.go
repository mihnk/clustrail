package kube

import (
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	storagev1 "k8s.io/api/storage/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
)

func ptrTo[T any](v T) *T { return &v }

func netpolFixture() []any {
	tcp := corev1.ProtocolTCP
	udp := corev1.ProtocolUDP
	port := func(p int) *intstr.IntOrString { v := intstr.FromInt32(int32(p)); return &v }
	named := intstr.FromString("metrics")
	return []any{
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "payments", Labels: map[string]string{"kubernetes.io/metadata.name": "payments"}}},
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "edge", Labels: map[string]string{"kubernetes.io/metadata.name": "edge", "zone": "edge"}}},
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "monitoring", Labels: map[string]string{"kubernetes.io/metadata.name": "monitoring"}}},
		pod("api-1", func(p *corev1.Pod) {
			p.Labels = map[string]string{"app": "api"}
			p.Status.PodIP = "10.1.0.5"
			p.Spec.Containers[0].Ports = []corev1.ContainerPort{{Name: "metrics", ContainerPort: 9090, Protocol: tcp}, {Name: "http", ContainerPort: 8080, Protocol: tcp}}
		}),
		pod("db-0", func(p *corev1.Pod) { p.Labels = map[string]string{"app": "db"}; p.Status.PodIP = "10.1.0.9" }),
		pod("gw-1", func(p *corev1.Pod) {
			p.Namespace = "edge"
			p.Labels = map[string]string{"app": "gateway"}
			p.Status.PodIP = "10.2.0.3"
		}),
		pod("prom-0", func(p *corev1.Pod) {
			p.Namespace = "monitoring"
			p.Labels = map[string]string{"app": "prometheus"}
			p.Status.PodIP = "10.3.0.2"
		}),
		// Default deny for every pod in payments.
		&networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: "default-deny", Namespace: "payments"}, Spec: networkingv1.NetworkPolicySpec{PolicyTypes: []networkingv1.PolicyType{"Ingress"}}},
		&networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: "allow-gateway", Namespace: "payments"}, Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{"app": "api"}},
			Ingress: []networkingv1.NetworkPolicyIngressRule{
				{From: []networkingv1.NetworkPolicyPeer{{NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"zone": "edge"}}, PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "gateway"}}}}, Ports: []networkingv1.NetworkPolicyPort{{Protocol: &tcp, Port: port(8080)}}},
				{From: []networkingv1.NetworkPolicyPeer{{NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"kubernetes.io/metadata.name": "monitoring"}}}}, Ports: []networkingv1.NetworkPolicyPort{{Port: &named}}},
				{From: []networkingv1.NetworkPolicyPeer{{IPBlock: &networkingv1.IPBlock{CIDR: "10.20.0.0/16", Except: []string{"10.20.5.0/24"}}}}},
			},
		}},
		&networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: "api-egress", Namespace: "payments"}, Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{"app": "api"}},
			PolicyTypes: []networkingv1.PolicyType{"Egress"},
			Egress: []networkingv1.NetworkPolicyEgressRule{
				{To: []networkingv1.NetworkPolicyPeer{{PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "db"}}}}, Ports: []networkingv1.NetworkPolicyPort{{Protocol: &tcp, Port: port(5432)}}},
				{Ports: []networkingv1.NetworkPolicyPort{{Protocol: &udp, Port: port(53)}}},
			},
		}},
	}
}

func TestNetworkPolicyViewAndConnections(t *testing.T) {
	var objs []any
	objs = append(objs, netpolFixture()...)
	c, _, _ := newFakeConn(t, toRuntime(objs)...)
	m := managerWith(c, false)

	v, err := m.PodNetworkPolicies("test", "payments", "api-1")
	if err != nil {
		t.Fatal(err)
	}
	if !v.Ingress.Isolated || len(v.Ingress.Policies) != 2 || len(v.Ingress.Rules) != 3 {
		t.Fatalf("ingress = %+v", v.Ingress)
	}
	r0 := v.Ingress.Rules[0]
	if r0.Policy != "allow-gateway" || r0.Peers != "Pods app=gateway in namespaces zone=edge" || r0.Ports != "TCP 8080" || r0.Pods != 1 {
		t.Fatalf("rule 1 = %+v", r0)
	}
	if v.Ingress.Rules[1].Peers != "All pods in namespaces kubernetes.io/metadata.name=monitoring" || v.Ingress.Rules[1].Ports != "TCP metrics" {
		t.Fatalf("rule 2 = %+v", v.Ingress.Rules[1])
	}
	if v.Ingress.Rules[2].Peers != "10.20.0.0/16 except 10.20.5.0/24" || v.Ingress.Rules[2].Pods != -1 || v.Ingress.Rules[2].Ports != "all ports" {
		t.Fatalf("rule 3 = %+v", v.Ingress.Rules[2])
	}
	if !v.Egress.Isolated || len(v.Egress.Rules) != 2 || v.Egress.Rules[1].Peers != "Anyone" {
		t.Fatalf("egress = %+v", v.Egress)
	}
	db, _ := m.PodNetworkPolicies("test", "payments", "db-0")
	if !db.Ingress.Isolated || len(db.Ingress.Rules) != 0 || db.Egress.Isolated {
		t.Fatalf("db = in %+v out %+v (default deny ingress, egress open)", db.Ingress, db.Egress)
	}

	check := func(srcNS, src, dstNS, dst, ip string, port int32, proto string) ConnectionCheck {
		t.Helper()
		r, err := m.CheckConnection("test", srcNS, src, dstNS, dst, ip, port, proto)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	if r := check("edge", "gw-1", "payments", "api-1", "", 8080, "TCP"); !r.Allowed || r.IngressVia != "allow-gateway rule 1" || r.EgressVia != "no policy selects the pod" {
		t.Fatalf("gateway → api:8080 = %+v", r)
	}
	if r := check("edge", "gw-1", "payments", "api-1", "", 9090, "TCP"); r.Allowed || r.Ingress {
		t.Fatalf("gateway → api:9090 = %+v", r)
	}
	if r := check("monitoring", "prom-0", "payments", "api-1", "", 9090, "TCP"); !r.Allowed || r.IngressVia != "allow-gateway rule 2" {
		t.Fatalf("prometheus → api:metrics = %+v", r)
	}
	if r := check("payments", "api-1", "payments", "db-0", "", 5432, "TCP"); r.Allowed || !r.Egress || r.Ingress || !strings.Contains(r.IngressVia, "default-deny") {
		t.Fatalf("api → db: egress allowed, db ingress denied by default-deny = %+v", r)
	}
	if r := check("payments", "api-1", "", "", "8.8.8.8", 53, "UDP"); !r.Allowed || r.EgressVia != "api-egress rule 2" {
		t.Fatalf("api → dns = %+v", r)
	}
	if r := check("payments", "api-1", "", "", "8.8.8.8", 443, "TCP"); r.Allowed {
		t.Fatalf("api → internet:443 = %+v", r)
	}
	if !ipInBlock("10.20.4.1", &networkingv1.IPBlock{CIDR: "10.20.0.0/16", Except: []string{"10.20.5.0/24"}}) || ipInBlock("10.20.5.1", &networkingv1.IPBlock{CIDR: "10.20.0.0/16", Except: []string{"10.20.5.0/24"}}) {
		t.Fatal("ipBlock except")
	}
}

func TestStorageJoinsClaimsVolumesClassesAndPods(t *testing.T) {
	class := "gp3"
	wffc := storagev1.VolumeBindingWaitForFirstConsumer
	q := resource.MustParse("100Gi")
	objs := []any{
		&storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: "gp3", Annotations: map[string]string{"storageclass.kubernetes.io/is-default-class": "true"}}, Provisioner: "ebs.csi.aws.com", VolumeBindingMode: &wffc, AllowVolumeExpansion: ptrTo(true)},
		&corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "data-db-0", Namespace: "payments"}, Spec: corev1.PersistentVolumeClaimSpec{StorageClassName: &class, VolumeName: "pvc-1", AccessModes: []corev1.PersistentVolumeAccessMode{"ReadWriteOnce"}, Resources: corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{"storage": q}}}, Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound, Capacity: corev1.ResourceList{"storage": q}}},
		&corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "data-db-2", Namespace: "payments"}, Spec: corev1.PersistentVolumeClaimSpec{StorageClassName: &class, Resources: corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{"storage": q}}}, Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimPending}},
		&corev1.PersistentVolume{ObjectMeta: metav1.ObjectMeta{Name: "pvc-1"}, Spec: corev1.PersistentVolumeSpec{StorageClassName: "gp3", Capacity: corev1.ResourceList{"storage": q}, ClaimRef: &corev1.ObjectReference{Namespace: "payments", Name: "data-db-0"}, PersistentVolumeReclaimPolicy: corev1.PersistentVolumeReclaimDelete, PersistentVolumeSource: corev1.PersistentVolumeSource{CSI: &corev1.CSIPersistentVolumeSource{Driver: "ebs.csi.aws.com", VolumeHandle: "vol-1"}}}, Status: corev1.PersistentVolumeStatus{Phase: corev1.VolumeBound}},
		&corev1.Event{ObjectMeta: metav1.ObjectMeta{Name: "e1", Namespace: "payments"}, InvolvedObject: corev1.ObjectReference{Kind: "PersistentVolumeClaim", Name: "data-db-2", Namespace: "payments"}, Reason: "ProvisioningFailed", Message: "could not create volume", Count: 6, LastTimestamp: metav1.Now()},
		pod("db-0", func(p *corev1.Pod) {
			p.Spec.Volumes = []corev1.Volume{{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: "data-db-0"}}}}
		}),
	}
	c, _, _ := newFakeConn(t, toRuntime(objs)...)
	m := managerWith(c, false)
	rep, err := m.Storage("test")
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Claims) != 2 || rep.Claims[0].Name != "data-db-2" {
		t.Fatalf("claims (problems first) = %+v", rep.Claims)
	}
	pending, bound := rep.Claims[0], rep.Claims[1]
	if pending.Health != Warning || pending.Reason != "ProvisioningFailed ×6 · could not create volume" || len(pending.Pods) != 0 {
		t.Fatalf("pending = %+v", pending)
	}
	if bound.Health != Healthy || bound.Capacity != "100Gi" || len(bound.Pods) != 1 || bound.Pods[0].Name != "db-0" || bound.Volume != "pvc-1" {
		t.Fatalf("bound = %+v", bound)
	}
	if len(rep.Volumes) != 1 || rep.Volumes[0].Source != "csi · ebs.csi.aws.com" || rep.Volumes[0].Claim != "payments/data-db-0" {
		t.Fatalf("volumes = %+v", rep.Volumes)
	}
	if len(rep.Classes) != 1 || !rep.Classes[0].Default || rep.Classes[0].Claims != 2 || rep.Classes[0].BindingMode != "WaitForFirstConsumer" || !rep.Classes[0].Expansion {
		t.Fatalf("classes = %+v", rep.Classes)
	}
}

func TestVolumeStatsFromKubeletSummary(t *testing.T) {
	raw := []byte(`{"pods":[{"volume":[{"name":"data","usedBytes":93,"capacityBytes":100,"pvcRef":{"name":"data-db-0","namespace":"payments"}},{"name":"tmp","usedBytes":1,"capacityBytes":2}]}]}`)
	got := parseVolumeStats(raw)
	if len(got) != 1 || got["payments/data-db-0"] != [2]int64{93, 100} {
		t.Fatalf("stats = %v", got)
	}
}

func toRuntime(objs []any) []runtime.Object {
	out := make([]runtime.Object, len(objs))
	for i, o := range objs {
		out[i] = o.(runtime.Object)
	}
	return out
}
