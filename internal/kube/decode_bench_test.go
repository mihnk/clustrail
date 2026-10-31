package kube

import (
	"fmt"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/serializer/protobuf"
	"k8s.io/client-go/kubernetes/scheme"
)

// What a list of 10,000 pods costs to decode as JSON and as protobuf, the two
// encodings the typed clients can ask the API server for:
//
//	go test -run - -bench Decode -benchmem ./internal/kube
func benchPodList(n int) *corev1.PodList {
	l := &corev1.PodList{TypeMeta: metav1.TypeMeta{Kind: "PodList", APIVersion: "v1"}}
	for i := range n {
		l.Items = append(l.Items, corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("checkout-api-7d9f8b6c4-%05d", i), Namespace: "payments", UID: "0b6a1c2e-6f1d-4a43-9c4e-3b9f8d1e7a10",
				ResourceVersion: "123456", Labels: map[string]string{"app": "checkout-api", "pod-template-hash": "7d9f8b6c4"},
				OwnerReferences: []metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "ReplicaSet", Name: "checkout-api-7d9f8b6c4", UID: "1c2e"}}},
			Spec: corev1.PodSpec{NodeName: "ip-10-42-3-17.eu-west-1.compute.internal", Containers: []corev1.Container{
				{Name: "api", Image: "ghcr.io/acme/checkout-api:v2.31.0", Ports: []corev1.ContainerPort{{Name: "http", ContainerPort: 8080}},
					Env: []corev1.EnvVar{{Name: "JAVA_TOOL_OPTIONS", Value: "-Xmx384m"}, {Name: "REGION", Value: "eu-west-1"}}},
				{Name: "envoy", Image: "envoyproxy/envoy:v1.31.0"},
			}},
			Status: corev1.PodStatus{Phase: corev1.PodRunning, PodIP: "10.1.4.17", ContainerStatuses: []corev1.ContainerStatus{
				{Name: "api", Ready: true, RestartCount: 0, Image: "ghcr.io/acme/checkout-api:v2.31.0"},
				{Name: "envoy", Ready: true, Image: "envoyproxy/envoy:v1.31.0"},
			}},
		})
	}
	return l
}

func BenchmarkDecodePodList(b *testing.B) {
	list := benchPodList(10000)
	codecs := scheme.Codecs
	jsonInfo, _ := runtime.SerializerInfoForMediaType(codecs.SupportedMediaTypes(), runtime.ContentTypeJSON)
	protoInfo, _ := runtime.SerializerInfoForMediaType(codecs.SupportedMediaTypes(), runtime.ContentTypeProtobuf)
	for _, c := range []struct {
		name string
		s    runtime.Serializer
	}{{"json", jsonInfo.Serializer}, {"protobuf", protoInfo.Serializer.(*protobuf.Serializer)}} {
		raw, err := runtime.Encode(c.s, list)
		if err != nil {
			b.Fatal(err)
		}
		b.Run(c.name, func(b *testing.B) {
			b.SetBytes(int64(len(raw)))
			b.ReportAllocs()
			for b.Loop() {
				if _, _, err := c.s.Decode(raw, nil, &corev1.PodList{}); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
