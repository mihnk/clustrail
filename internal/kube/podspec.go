package kube

import (
	"fmt"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// The Containers tab: what each container of a pod runs with, read from the
// live pod (the cache drops commands, probes and literal env values).

type ContainerPort struct {
	Name     string `json:"name,omitempty"`
	Port     int32  `json:"port"`
	Protocol string `json:"protocol"`
}

// EnvVar is one variable. Exactly one of Value, From or Hidden says where it comes from.
type EnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value,omitempty"`
	// Hidden: a literal value whose name looks secret; not sent.
	Hidden bool `json:"hidden,omitempty"`
	// From: "Secret", "ConfigMap", "field" or "resource".
	From string `json:"from,omitempty"`
	// Ref: the object (Secret or ConfigMap name) or the field path.
	Ref      string `json:"ref,omitempty"`
	Key      string `json:"key,omitempty"`
	Optional bool   `json:"optional,omitempty"`
}

// EnvSource is an envFrom entry: every key of a ConfigMap or Secret.
type EnvSource struct {
	Kind     string `json:"kind"` // ConfigMap or Secret
	Name     string `json:"name"`
	Prefix   string `json:"prefix,omitempty"`
	Optional bool   `json:"optional,omitempty"`
}

type VolumeMount struct {
	Path     string `json:"path"`
	SubPath  string `json:"subPath,omitempty"`
	ReadOnly bool   `json:"readOnly,omitempty"`
	Volume   string `json:"volume"`
	// Source describes the volume: "ConfigMap checkout-config", "emptyDir (Memory, 64Mi)", …
	Source string `json:"source"`
	// Kind and Ref point at an object to open (ConfigMap, Secret, PersistentVolumeClaim).
	Kind string `json:"kind,omitempty"`
	Ref  string `json:"ref,omitempty"`
}

type Probe struct {
	Kind string `json:"kind"` // liveness, readiness, startup
	// Action: "GET :8080/healthz", "TCP :5432", "exec pg_isready", "gRPC :9000".
	Action           string `json:"action"`
	InitialDelay     int32  `json:"initialDelay"`
	Period           int32  `json:"period"`
	Timeout          int32  `json:"timeout"`
	FailureThreshold int32  `json:"failureThreshold"`
	SuccessThreshold int32  `json:"successThreshold"`
}

type ContainerSpec struct {
	Name string `json:"name"`
	// Type: "init", "sidecar" (an init container that keeps running), "main" or "ephemeral".
	Type       string            `json:"type"`
	Image      string            `json:"image"`
	ImageID    string            `json:"imageID,omitempty"` // what runs, from the status
	PullPolicy string            `json:"pullPolicy,omitempty"`
	Command    []string          `json:"command"`
	Args       []string          `json:"args"`
	WorkingDir string            `json:"workingDir,omitempty"`
	Ports      []ContainerPort   `json:"ports"`
	Requests   map[string]string `json:"requests"`
	Limits     map[string]string `json:"limits"`
	Env        []EnvVar          `json:"env"`
	EnvFrom    []EnvSource       `json:"envFrom"`
	Mounts     []VolumeMount     `json:"mounts"`
	Probes     []Probe           `json:"probes"`
	// Security lists the security context settings that are set ("runAsNonRoot", "drop ALL", …).
	Security []string `json:"security"`
}

type PodSpecInfo struct {
	ServiceAccount string          `json:"serviceAccount,omitempty"`
	Node           string          `json:"node,omitempty"`
	QOSClass       string          `json:"qosClass,omitempty"`
	PriorityClass  string          `json:"priorityClass,omitempty"`
	RestartPolicy  string          `json:"restartPolicy,omitempty"`
	HostNetwork    bool            `json:"hostNetwork,omitempty"`
	Containers     []ContainerSpec `json:"containers"`
}

// PodContainers reads the live pod and describes each container.
func (m *Manager) PodContainers(cluster, ns, name string) (PodSpecInfo, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return PodSpecInfo{}, err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	p, err := c.client.CoreV1().Pods(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return PodSpecInfo{}, err
	}
	return podSpecInfo(p), nil
}

func podSpecInfo(p *corev1.Pod) PodSpecInfo {
	out := PodSpecInfo{
		ServiceAccount: p.Spec.ServiceAccountName, Node: p.Spec.NodeName, QOSClass: string(p.Status.QOSClass),
		PriorityClass: p.Spec.PriorityClassName, RestartPolicy: string(p.Spec.RestartPolicy), HostNetwork: p.Spec.HostNetwork,
		Containers: []ContainerSpec{},
	}
	volumes := map[string]corev1.Volume{}
	for _, v := range p.Spec.Volumes {
		volumes[v.Name] = v
	}
	imageIDs := map[string]string{}
	for _, list := range [][]corev1.ContainerStatus{p.Status.InitContainerStatuses, p.Status.ContainerStatuses, p.Status.EphemeralContainerStatuses} {
		for _, s := range list {
			imageIDs[s.Name] = s.ImageID
		}
	}
	for _, ct := range p.Spec.InitContainers {
		typ := "init"
		if ct.RestartPolicy != nil && *ct.RestartPolicy == corev1.ContainerRestartPolicyAlways {
			typ = "sidecar"
		}
		out.Containers = append(out.Containers, containerSpec(ct, typ, imageIDs[ct.Name], volumes))
	}
	for _, ct := range p.Spec.Containers {
		out.Containers = append(out.Containers, containerSpec(ct, "main", imageIDs[ct.Name], volumes))
	}
	for _, e := range p.Spec.EphemeralContainers {
		out.Containers = append(out.Containers, containerSpec(corev1.Container(e.EphemeralContainerCommon), "ephemeral", imageIDs[e.Name], volumes))
	}
	return out
}

func containerSpec(ct corev1.Container, typ, imageID string, volumes map[string]corev1.Volume) ContainerSpec {
	s := ContainerSpec{
		Name: ct.Name, Type: typ, Image: ct.Image, ImageID: imageID, PullPolicy: string(ct.ImagePullPolicy),
		Command: orEmpty(ct.Command), Args: orEmpty(ct.Args), WorkingDir: ct.WorkingDir,
		Ports: []ContainerPort{}, Requests: quantities(ct.Resources.Requests), Limits: quantities(ct.Resources.Limits),
		Env: []EnvVar{}, EnvFrom: []EnvSource{}, Mounts: []VolumeMount{}, Probes: []Probe{}, Security: securitySummary(ct.SecurityContext),
	}
	for _, p := range ct.Ports {
		s.Ports = append(s.Ports, ContainerPort{Name: p.Name, Port: p.ContainerPort, Protocol: orDefault(string(p.Protocol), "TCP")})
	}
	for _, e := range ct.Env {
		s.Env = append(s.Env, envVar(e))
	}
	for _, f := range ct.EnvFrom {
		switch {
		case f.ConfigMapRef != nil:
			s.EnvFrom = append(s.EnvFrom, EnvSource{Kind: "ConfigMap", Name: f.ConfigMapRef.Name, Prefix: f.Prefix, Optional: deref(f.ConfigMapRef.Optional)})
		case f.SecretRef != nil:
			s.EnvFrom = append(s.EnvFrom, EnvSource{Kind: "Secret", Name: f.SecretRef.Name, Prefix: f.Prefix, Optional: deref(f.SecretRef.Optional)})
		}
	}
	for _, m := range ct.VolumeMounts {
		vm := VolumeMount{Path: m.MountPath, SubPath: m.SubPath, ReadOnly: m.ReadOnly, Volume: m.Name}
		vm.Source, vm.Kind, vm.Ref = podVolumeSource(volumes[m.Name])
		s.Mounts = append(s.Mounts, vm)
	}
	for _, pr := range []struct {
		kind  string
		probe *corev1.Probe
	}{{"liveness", ct.LivenessProbe}, {"readiness", ct.ReadinessProbe}, {"startup", ct.StartupProbe}} {
		if pr.probe != nil {
			s.Probes = append(s.Probes, probe(pr.kind, pr.probe))
		}
	}
	return s
}

func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func deref(b *bool) bool { return b != nil && *b }

func quantities(l corev1.ResourceList) map[string]string {
	out := map[string]string{}
	for k, v := range l {
		out[string(k)] = v.String()
	}
	return out
}

func envVar(e corev1.EnvVar) EnvVar {
	v := EnvVar{Name: e.Name}
	src := e.ValueFrom
	switch {
	case src == nil:
		if looksSecret(e.Name) && e.Value != "" {
			v.Hidden = true
		} else {
			v.Value = e.Value
		}
	case src.SecretKeyRef != nil:
		v.From, v.Ref, v.Key, v.Optional = "Secret", src.SecretKeyRef.Name, src.SecretKeyRef.Key, deref(src.SecretKeyRef.Optional)
	case src.ConfigMapKeyRef != nil:
		v.From, v.Ref, v.Key, v.Optional = "ConfigMap", src.ConfigMapKeyRef.Name, src.ConfigMapKeyRef.Key, deref(src.ConfigMapKeyRef.Optional)
	case src.FieldRef != nil:
		v.From, v.Ref = "field", src.FieldRef.FieldPath
	case src.ResourceFieldRef != nil:
		v.From, v.Ref = "resource", src.ResourceFieldRef.Resource
		if src.ResourceFieldRef.ContainerName != "" {
			v.Ref = src.ResourceFieldRef.ContainerName + "/" + v.Ref
		}
	}
	return v
}

// podVolumeSource describes a volume and, when it names an object, its kind and name.
func podVolumeSource(v corev1.Volume) (desc, kind, ref string) {
	switch s := v.VolumeSource; {
	case s.ConfigMap != nil:
		return "ConfigMap " + s.ConfigMap.Name, "ConfigMap", s.ConfigMap.Name
	case s.Secret != nil:
		return "Secret " + s.Secret.SecretName, "Secret", s.Secret.SecretName
	case s.PersistentVolumeClaim != nil:
		return "PersistentVolumeClaim " + s.PersistentVolumeClaim.ClaimName, "PersistentVolumeClaim", s.PersistentVolumeClaim.ClaimName
	case s.EmptyDir != nil:
		var parts []string
		if s.EmptyDir.Medium != "" {
			parts = append(parts, string(s.EmptyDir.Medium))
		}
		if s.EmptyDir.SizeLimit != nil {
			parts = append(parts, s.EmptyDir.SizeLimit.String())
		}
		if len(parts) == 0 {
			return "emptyDir", "", ""
		}
		return "emptyDir (" + strings.Join(parts, ", ") + ")", "", ""
	case s.HostPath != nil:
		return "hostPath " + s.HostPath.Path, "", ""
	case s.Projected != nil:
		var parts []string
		for _, p := range s.Projected.Sources {
			switch {
			case p.ServiceAccountToken != nil:
				parts = append(parts, "service account token")
			case p.ConfigMap != nil:
				parts = append(parts, "ConfigMap "+p.ConfigMap.Name)
			case p.Secret != nil:
				parts = append(parts, "Secret "+p.Secret.Name)
			case p.DownwardAPI != nil:
				parts = append(parts, "downward API")
			case p.ClusterTrustBundle != nil:
				parts = append(parts, "cluster trust bundle")
			}
		}
		return "projected: " + strings.Join(parts, ", "), "", ""
	case s.DownwardAPI != nil:
		return "downward API", "", ""
	case s.CSI != nil:
		return "CSI " + s.CSI.Driver, "", ""
	case s.Ephemeral != nil:
		return "ephemeral volume (a PVC per pod)", "", ""
	case s.NFS != nil:
		return fmt.Sprintf("NFS %s:%s", s.NFS.Server, s.NFS.Path), "", ""
	case s.Image != nil:
		return "image " + s.Image.Reference, "", ""
	case v.Name == "":
		return "volume not found in the pod", "", ""
	}
	return "other volume type", "", ""
}

func probe(kind string, p *corev1.Probe) Probe {
	out := Probe{Kind: kind, InitialDelay: p.InitialDelaySeconds, Period: p.PeriodSeconds, Timeout: p.TimeoutSeconds, FailureThreshold: p.FailureThreshold, SuccessThreshold: p.SuccessThreshold}
	switch h := p.ProbeHandler; {
	case h.HTTPGet != nil:
		scheme := ""
		if h.HTTPGet.Scheme == corev1.URISchemeHTTPS {
			scheme = "HTTPS "
		}
		out.Action = fmt.Sprintf("%sGET :%s%s", scheme, portString(h.HTTPGet.Port), h.HTTPGet.Path)
	case h.TCPSocket != nil:
		out.Action = "TCP :" + portString(h.TCPSocket.Port)
	case h.Exec != nil:
		out.Action = "exec " + strings.Join(h.Exec.Command, " ")
	case h.GRPC != nil:
		out.Action = fmt.Sprintf("gRPC :%d", h.GRPC.Port)
		if h.GRPC.Service != nil && *h.GRPC.Service != "" {
			out.Action += " " + *h.GRPC.Service
		}
	}
	return out
}

func portString(p intstr.IntOrString) string {
	if p.Type == intstr.String {
		return p.StrVal
	}
	return fmt.Sprint(p.IntVal)
}

func securitySummary(sc *corev1.SecurityContext) []string {
	out := []string{}
	if sc == nil {
		return out
	}
	if sc.Privileged != nil && *sc.Privileged {
		out = append(out, "privileged")
	}
	if sc.RunAsUser != nil {
		out = append(out, fmt.Sprintf("runAsUser %d", *sc.RunAsUser))
	}
	if sc.RunAsNonRoot != nil && *sc.RunAsNonRoot {
		out = append(out, "runAsNonRoot")
	}
	if sc.ReadOnlyRootFilesystem != nil && *sc.ReadOnlyRootFilesystem {
		out = append(out, "readOnlyRootFilesystem")
	}
	if sc.AllowPrivilegeEscalation != nil && !*sc.AllowPrivilegeEscalation {
		out = append(out, "no privilege escalation")
	}
	if c := sc.Capabilities; c != nil {
		if len(c.Drop) > 0 {
			out = append(out, "drop "+joinCaps(c.Drop))
		}
		if len(c.Add) > 0 {
			out = append(out, "add "+joinCaps(c.Add))
		}
	}
	return out
}

func joinCaps(cs []corev1.Capability) string {
	s := make([]string, len(cs))
	for i, c := range cs {
		s[i] = string(c)
	}
	sort.Strings(s)
	return strings.Join(s, ",")
}
