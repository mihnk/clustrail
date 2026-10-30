package kube

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
)

func TestResolveForwardTarget(t *testing.T) {
	mk := func(name string, ready bool, age time.Duration) *corev1.Pod {
		st := corev1.ConditionFalse
		if ready {
			st = corev1.ConditionTrue
		}
		return &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "payments", Labels: map[string]string{"app": "api"}, CreationTimestamp: metav1.NewTime(time.Now().Add(-age))},
			Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "api", Ports: []corev1.ContainerPort{{Name: "http", ContainerPort: 8080}}}}},
			Status:     corev1.PodStatus{Phase: corev1.PodRunning, Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: st}}},
		}
	}
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "payments"},
		Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "api"}, Ports: []corev1.ServicePort{
			{Name: "web", Port: 80, TargetPort: intstr.FromString("http")},
			{Name: "metrics", Port: 9090, TargetPort: intstr.FromInt32(9091)},
		}},
	}
	c, _, _ := newFakeConn(t, mk("api-old", true, time.Hour), mk("api-new", true, time.Minute), mk("api-starting", false, 0), svc)
	ctx := context.Background()

	pod, port, err := resolveForwardTarget(ctx, c, PortForwardRequest{Namespace: "payments", Kind: "Service", Name: "api", Port: 80})
	if err != nil || pod != "api-new" || port != 8080 {
		t.Fatalf("named targetPort: %s %d %v", pod, port, err)
	}
	if _, port, _ := resolveForwardTarget(ctx, c, PortForwardRequest{Namespace: "payments", Kind: "Service", Name: "api", Port: 9090}); port != 9091 {
		t.Fatalf("numeric targetPort = %d", port)
	}
	if _, _, err := resolveForwardTarget(ctx, c, PortForwardRequest{Namespace: "payments", Kind: "Service", Name: "api", Port: 443}); err == nil {
		t.Fatal("unknown service port must fail")
	}
	if pod, port, err := resolveForwardTarget(ctx, c, PortForwardRequest{Namespace: "payments", Kind: "Pod", Name: "api-old", Port: 8080}); err != nil || pod != "api-old" || port != 8080 {
		t.Fatalf("pod: %s %d %v", pod, port, err)
	}
}

func TestPortForwardListAndStop(t *testing.T) {
	m := &Manager{}
	ctx, cancel := context.WithCancel(context.Background())
	m.forwards.byID = map[string]*portForward{
		"pf-2":  {info: PortForward{ID: "pf-2", Cluster: "b"}, cancel: func() {}},
		"pf-10": {info: PortForward{ID: "pf-10", Cluster: "a"}, cancel: cancel},
	}
	if l := m.PortForwards(); len(l) != 2 || l[0].ID != "pf-2" {
		t.Fatalf("order = %+v", l)
	}
	m.stopForwardsOf("a")
	if ctx.Err() == nil || len(m.PortForwards()) != 1 {
		t.Fatal("forwards of a disconnected cluster must stop")
	}
}
