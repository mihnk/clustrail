package kube

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
)

func TestPodContainersFromTheLivePod(t *testing.T) {
	always := corev1.ContainerRestartPolicyAlways
	p := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "api-1", Namespace: "payments"},
		Spec: corev1.PodSpec{
			ServiceAccountName: "checkout-api", NodeName: "node-1", PriorityClassName: "high", RestartPolicy: corev1.RestartPolicyAlways,
			InitContainers: []corev1.Container{
				{Name: "migrate", Image: "migrate:1", Command: []string{"./migrate", "up"}},
				{Name: "proxy", Image: "envoy:1.30", RestartPolicy: &always},
			},
			Containers: []corev1.Container{{
				Name: "api", Image: "ghcr.io/acme/api:2.14", ImagePullPolicy: corev1.PullIfNotPresent,
				Command: []string{"java"}, Args: []string{"-jar", "/app.jar"}, WorkingDir: "/app",
				Ports: []corev1.ContainerPort{{Name: "http", ContainerPort: 8080}, {ContainerPort: 9090, Protocol: corev1.ProtocolUDP}},
				Resources: corev1.ResourceRequirements{
					Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("250m"), corev1.ResourceMemory: resource.MustParse("256Mi")},
					Limits:   corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("256Mi")},
				},
				Env: []corev1.EnvVar{
					{Name: "PROFILE", Value: "prod"},
					{Name: "API_TOKEN", Value: "s3cr3t"},
					{Name: "DB_PASSWORD", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: "ledger-db"}, Key: "password"}}},
					{Name: "LEVEL", ValueFrom: &corev1.EnvVarSource{ConfigMapKeyRef: &corev1.ConfigMapKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: "cfg"}, Key: "level", Optional: ptrTo(true)}}},
					{Name: "POD_IP", ValueFrom: &corev1.EnvVarSource{FieldRef: &corev1.ObjectFieldSelector{FieldPath: "status.podIP"}}},
					{Name: "MEM", ValueFrom: &corev1.EnvVarSource{ResourceFieldRef: &corev1.ResourceFieldSelector{Resource: "limits.memory"}}},
				},
				EnvFrom: []corev1.EnvFromSource{{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "checkout-config"}}, Prefix: "APP_"}},
				VolumeMounts: []corev1.VolumeMount{
					{Name: "config", MountPath: "/etc/checkout", ReadOnly: true},
					{Name: "tmp", MountPath: "/tmp"},
					{Name: "data", MountPath: "/data", SubPath: "api"},
					{Name: "token", MountPath: "/var/run/secrets/kubernetes.io/serviceaccount"},
				},
				LivenessProbe:  &corev1.Probe{ProbeHandler: corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Path: "/healthz", Port: intstr.FromInt32(8080)}}, InitialDelaySeconds: 20, PeriodSeconds: 10, TimeoutSeconds: 1, FailureThreshold: 3},
				ReadinessProbe: &corev1.Probe{ProbeHandler: corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromString("http")}}},
				StartupProbe:   &corev1.Probe{ProbeHandler: corev1.ProbeHandler{Exec: &corev1.ExecAction{Command: []string{"cat", "/ready"}}}},
				SecurityContext: &corev1.SecurityContext{
					RunAsNonRoot: ptrTo(true), ReadOnlyRootFilesystem: ptrTo(true), AllowPrivilegeEscalation: ptrTo(false),
					Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
				},
			}},
			EphemeralContainers: []corev1.EphemeralContainer{{EphemeralContainerCommon: corev1.EphemeralContainerCommon{Name: "debugger-x", Image: "busybox"}}},
			Volumes: []corev1.Volume{
				{Name: "config", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: "checkout-config"}}}},
				{Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{Medium: corev1.StorageMediumMemory, SizeLimit: ptrTo(resource.MustParse("64Mi"))}}},
				{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: "api-data"}}},
				{Name: "token", VolumeSource: corev1.VolumeSource{Projected: &corev1.ProjectedVolumeSource{Sources: []corev1.VolumeProjection{
					{ServiceAccountToken: &corev1.ServiceAccountTokenProjection{Path: "token"}},
					{ConfigMap: &corev1.ConfigMapProjection{LocalObjectReference: corev1.LocalObjectReference{Name: "kube-root-ca.crt"}}},
					{DownwardAPI: &corev1.DownwardAPIProjection{}},
				}}}},
			},
		},
		Status: corev1.PodStatus{QOSClass: corev1.PodQOSBurstable, ContainerStatuses: []corev1.ContainerStatus{{Name: "api", ImageID: "ghcr.io/acme/api@sha256:9f1c"}}},
	}
	c, _, _ := newFakeConn(t, p)
	m := managerWith(c, true) // reading works on a read-only context
	info, err := m.PodContainers("test", "payments", "api-1")
	if err != nil {
		t.Fatal(err)
	}
	if info.ServiceAccount != "checkout-api" || info.QOSClass != "Burstable" || info.PriorityClass != "high" || info.Node != "node-1" {
		t.Fatalf("pod fields = %+v", info)
	}
	types := []string{}
	for _, c := range info.Containers {
		types = append(types, c.Name+":"+c.Type)
	}
	if got := join(types); got != "migrate:init proxy:sidecar api:main debugger-x:ephemeral" {
		t.Fatalf("containers = %s", got)
	}
	api := info.Containers[2]
	if api.ImageID != "ghcr.io/acme/api@sha256:9f1c" || join(api.Command) != "java" || join(api.Args) != "-jar /app.jar" || api.WorkingDir != "/app" {
		t.Fatalf("api = %+v", api)
	}
	if len(api.Ports) != 2 || api.Ports[0] != (ContainerPort{Name: "http", Port: 8080, Protocol: "TCP"}) || api.Ports[1].Protocol != "UDP" {
		t.Fatalf("ports = %+v", api.Ports)
	}
	if api.Requests["cpu"] != "250m" || api.Limits["memory"] != "256Mi" || api.Limits["cpu"] != "" {
		t.Fatalf("resources = %v / %v", api.Requests, api.Limits)
	}
	want := []EnvVar{
		{Name: "PROFILE", Value: "prod"},
		{Name: "API_TOKEN", Hidden: true},
		{Name: "DB_PASSWORD", From: "Secret", Ref: "ledger-db", Key: "password"},
		{Name: "LEVEL", From: "ConfigMap", Ref: "cfg", Key: "level", Optional: true},
		{Name: "POD_IP", From: "field", Ref: "status.podIP"},
		{Name: "MEM", From: "resource", Ref: "limits.memory"},
	}
	for i, w := range want {
		if api.Env[i] != w {
			t.Errorf("env %d = %+v, want %+v", i, api.Env[i], w)
		}
	}
	if len(api.EnvFrom) != 1 || api.EnvFrom[0] != (EnvSource{Kind: "ConfigMap", Name: "checkout-config", Prefix: "APP_"}) {
		t.Fatalf("envFrom = %+v", api.EnvFrom)
	}
	mounts := map[string]VolumeMount{}
	for _, vm := range api.Mounts {
		mounts[vm.Path] = vm
	}
	if m := mounts["/etc/checkout"]; m.Source != "ConfigMap checkout-config" || m.Kind != "ConfigMap" || m.Ref != "checkout-config" || !m.ReadOnly {
		t.Errorf("config mount = %+v", m)
	}
	if m := mounts["/tmp"]; m.Source != "emptyDir (Memory, 64Mi)" || m.Kind != "" {
		t.Errorf("tmp mount = %+v", m)
	}
	if m := mounts["/data"]; m.Kind != "PersistentVolumeClaim" || m.Ref != "api-data" || m.SubPath != "api" {
		t.Errorf("data mount = %+v", m)
	}
	if m := mounts["/var/run/secrets/kubernetes.io/serviceaccount"]; m.Source != "projected: service account token, ConfigMap kube-root-ca.crt, downward API" {
		t.Errorf("token mount = %+v", m)
	}
	probes := map[string]Probe{}
	for _, p := range api.Probes {
		probes[p.Kind] = p
	}
	if p := probes["liveness"]; p.Action != "GET :8080/healthz" || p.InitialDelay != 20 || p.Period != 10 || p.FailureThreshold != 3 {
		t.Errorf("liveness = %+v", p)
	}
	if probes["readiness"].Action != "TCP :http" || probes["startup"].Action != "exec cat /ready" {
		t.Errorf("probes = %+v", probes)
	}
	if got := join(api.Security); got != "runAsNonRoot readOnlyRootFilesystem no privilege escalation drop ALL" {
		t.Errorf("security = %q", got)
	}
}

func join(s []string) string {
	out := ""
	for i, x := range s {
		if i > 0 {
			out += " "
		}
		out += x
	}
	return out
}
