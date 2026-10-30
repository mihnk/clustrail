// Package kube owns everything that talks to Kubernetes API servers:
// kubeconfig loading, one connection per context with informers and caches,
// metrics polling, actions, and log/exec streams. It produces the view models
// the frontend renders; the frontend never contacts an API server itself.
package kube

// The JSON shapes below mirror frontend/src/data/types.ts. Optional fields use
// pointers or omitempty so "unknown" stays distinguishable from zero.

type Environment string

const (
	EnvProd Environment = "prod"
	EnvStg  Environment = "stg"
	EnvDev  Environment = "dev"
)

type ConnectionState string

const (
	Connected    ConnectionState = "connected"
	Connecting   ConnectionState = "connecting"
	Reconnecting ConnectionState = "reconnecting"
	Disconnected ConnectionState = "disconnected"
	AuthExpired  ConnectionState = "auth-expired"
	Unreachable  ConnectionState = "unreachable"
)

type Health string

const (
	Failed      Health = "failed"
	Warning     Health = "warning"
	Progressing Health = "progressing"
	Healthy     Health = "healthy"
	Completed   Health = "completed"
	Terminating Health = "terminating"
	Unknown     Health = "unknown"
	Idle        Health = "idle"
	Paused      Health = "paused"
	Cordoned    Health = "cordoned"
)

type AuthHint struct {
	Plugin  string `json:"plugin"`
	Command string `json:"command"`
}

type Stale struct {
	Since        int64 `json:"since"`
	Attempt      int   `json:"attempt"`
	NextRetrySec int   `json:"nextRetrySec"`
}

type Cluster struct {
	ID            string          `json:"id"`
	Name          string          `json:"name"`
	Context       string          `json:"context"`
	Env           Environment     `json:"env"`
	Protected     bool            `json:"protected"`
	Connection    ConnectionState `json:"connection"`
	LatencyMs     *int            `json:"latencyMs"`
	Summary       *string         `json:"summary"`
	ReadOnly      bool            `json:"readOnly"`
	Metrics       *string         `json:"metrics"`
	Error         string          `json:"error,omitempty"`
	AuthHint      *AuthHint       `json:"authHint,omitempty"`
	LastConnected string          `json:"lastConnected,omitempty"`
	Stale         *Stale          `json:"stale,omitempty"`
	Server        string          `json:"server,omitempty"`
	Auth          string          `json:"auth,omitempty"`
	Source        string          `json:"source,omitempty"`
	Version       string          `json:"version,omitempty"`
	Identity      string          `json:"identity,omitempty"`
}

type OwnerRef struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

type PodRow struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	Namespace       string            `json:"namespace"`
	Cluster         string            `json:"cluster"`
	Env             Environment       `json:"env"`
	Node            string            `json:"node"`
	Health          Health            `json:"health"`
	Status          string            `json:"status"`
	Reason          string            `json:"reason"`
	ReadyContainers int               `json:"readyContainers"`
	TotalContainers int               `json:"totalContainers"`
	Restarts        int               `json:"restarts"`
	CPUMilli        *int              `json:"cpuMilli"`
	MemoryMiB       *int              `json:"memoryMiB"`
	AgeSeconds      int64             `json:"ageSeconds"`
	Owner           *OwnerRef         `json:"owner"`
	Labels          map[string]string `json:"labels"`
	StaleSeconds    *int64            `json:"staleSeconds,omitempty"`
}

type HPARef struct {
	Name string `json:"name"`
	Min  int32  `json:"min"`
	Max  int32  `json:"max"`
}

type Revision struct {
	Rev   int64  `json:"rev"`
	Image string `json:"image"`
	Age   string `json:"age"`
	Sync  string `json:"sync,omitempty"`
}

type DeploymentUsage struct {
	CPUMilli        int `json:"cpuMilli"`
	CPURequestMilli int `json:"cpuRequestMilli"`
	MemoryMiB       int `json:"memoryMiB"`
	MemoryLimitMiB  int `json:"memoryLimitMiB"`
}

type Strategy struct {
	Type           string `json:"type"`
	MaxSurge       string `json:"maxSurge,omitempty"`
	MaxUnavailable string `json:"maxUnavailable,omitempty"`
}

type DeploymentRow struct {
	ID                string           `json:"id"`
	Name              string           `json:"name"`
	Namespace         string           `json:"namespace"`
	Cluster           string           `json:"cluster"`
	Env               Environment      `json:"env"`
	Health            Health           `json:"health"`
	Status            string           `json:"status"`
	Rollout           string           `json:"rollout"`
	Reason            string           `json:"reason"`
	Since             string           `json:"since,omitempty"`
	Image             string           `json:"image"`
	HPA               *HPARef          `json:"hpa,omitempty"`
	ArgoApp           string           `json:"argoApp,omitempty"`
	Revisions         []Revision       `json:"revisions"`
	Usage             *DeploymentUsage `json:"usage,omitempty"`
	ReadyReplicas     int32            `json:"readyReplicas"`
	Replicas          int32            `json:"replicas"`
	UpdatedReplicas   int32            `json:"updatedReplicas"`
	AvailableReplicas int32            `json:"availableReplicas"`
	Strategy          Strategy         `json:"strategy"`
	AgeSeconds        int64            `json:"ageSeconds"`
}

type NodeCondition struct {
	Type   string `json:"type"`
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
	Since  string `json:"since"`
	OK     bool   `json:"ok"`
}

type Taint struct {
	Key    string `json:"key"`
	Value  string `json:"value,omitempty"`
	Effect string `json:"effect"`
}

type NodeCPU struct {
	Used        *float64 `json:"used"`
	Requests    float64  `json:"requests"`
	Limits      float64  `json:"limits"`
	Allocatable float64  `json:"allocatable"`
}

type NodeMemory struct {
	Used        *float64 `json:"used"`
	Requests    float64  `json:"requests"`
	Allocatable float64  `json:"allocatable"`
}

type NodeRow struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Cluster      string            `json:"cluster"`
	Env          Environment       `json:"env"`
	Health       Health            `json:"health"`
	Status       string            `json:"status"`
	Reason       string            `json:"reason"`
	Roles        string            `json:"roles"`
	Version      string            `json:"version"`
	GitVersion   string            `json:"gitVersion"`
	InstanceType string            `json:"instanceType"`
	Zone         string            `json:"zone"`
	CPUPct       *int              `json:"cpuPct"`
	MemPct       *int              `json:"memPct"`
	CPU          NodeCPU           `json:"cpu"`
	MemoryGiB    NodeMemory        `json:"memoryGiB"`
	Pods         int               `json:"pods"`
	PodCapacity  int64             `json:"podCapacity"`
	Taints       []Taint           `json:"taints"`
	AgeSeconds   int64             `json:"ageSeconds"`
	Conditions   []NodeCondition   `json:"conditions"`
	Heartbeat    string            `json:"heartbeat"`
	CordonedBy   string            `json:"cordonedBy,omitempty"`
	CordonedAgo  string            `json:"cordonedAgo,omitempty"`
	Labels       map[string]string `json:"labels"`
}

// Delta is one batch of watch changes for one kind in one cluster.
type Delta struct {
	Cluster string   `json:"cluster"`
	Kind    string   `json:"kind"`
	Upserts []any    `json:"upserts"`
	Deletes []string `json:"deletes"`
	// Reset replaces every row of this kind in this cluster (initial list, re-list).
	Reset bool `json:"reset,omitempty"`
}

// Snapshot is everything the frontend needs to render after start or reload.
type Snapshot struct {
	Clusters    []Cluster       `json:"clusters"`
	Pods        []PodRow        `json:"pods"`
	Deployments []DeploymentRow `json:"deployments"`
	Nodes       []NodeRow       `json:"nodes"`
	Helm        []HelmRelease   `json:"helm"`
	GitOps      []GitOpsObject  `json:"gitops"`
}
