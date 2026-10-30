// View models the UI renders. In the desktop build these are produced by
// the Go backend (client-go informers -> resource cache -> Wails bindings);
// the frontend never talks to a Kubernetes API server itself.

export type Environment = "prod" | "stg" | "dev";

export type ConnectionState =
  | "connected"
  /** Initial list in progress. */
  | "connecting"
  /** Watch lost; data shown is stale until it recovers. */
  | "reconnecting"
  /** Not connected on purpose (never auto-connected). */
  | "disconnected"
  /** The kubeconfig auth plugin failed or returned an expired token. */
  | "auth-expired"
  /** TCP/TLS to the API server failed. */
  | "unreachable";

/** Health category. Every category has its own glyph silhouette. */
export type Health =
  | "failed"
  | "warning"
  | "progressing"
  | "healthy"
  | "completed"
  | "terminating"
  /** Status not reported: stale data, unreachable cluster. */
  | "unknown"
  /** Exists but runs nothing, e.g. an old ReplicaSet with 0 pods. */
  | "idle"
  /** Rollout paused on purpose (spec.paused). */
  | "paused"
  /** Node marked unschedulable. */
  | "cordoned";

export interface Cluster {
  /** Stable id; also the display name. */
  id: string;
  name: string;
  /** kubeconfig context this cluster is reached through. */
  context: string;
  env: Environment;
  /** Clustrail protection (client-side). Never a substitute for RBAC. */
  protected: boolean;
  connection: ConnectionState;
  latencyMs: number | null;
  /** From server version and node labels, e.g. "EKS 1.30 · eu-west-1". Unknown until connected. */
  summary: string | null;
  /** Clustrail read-only mode: blocks changes and shell. Never a substitute for RBAC. */
  readOnly: boolean;
  /** Usage metrics source, or null when metrics.k8s.io is not available. */
  metrics: "metrics-server" | null;
  /** Why the cluster is not connected, verbatim from the client (e.g. auth plugin or dial error). */
  error?: string;
  /** For auth-expired: the plugin and the command the user runs in their own terminal. */
  authHint?: { plugin: string; command: string };
  lastConnected?: string;
  /** While reconnecting: when data went stale and the retry loop state. */
  stale?: { since: number; attempt: number; nextRetrySec: number };
  /** From the kubeconfig: API server URL, auth method and the file the context is defined in. */
  server?: string;
  auth?: string;
  source?: string;
  /** Kubernetes version and the identity RBAC sees (SelfSubjectReview), once connected. */
  version?: string;
  identity?: string;
}

export interface PodRow {
  /** Stable row identity across watch updates: cluster/namespace/name. */
  id: string;
  name: string;
  namespace: string;
  cluster: string;
  env: Environment;
  node: string;
  health: Health;
  /** Short status shown in the table, e.g. "CrashLoop". */
  status: string;
  /** Full reason shown on hover, e.g. "CrashLoopBackOff". */
  reason: string;
  readyContainers: number;
  totalContainers: number;
  restarts: number;
  /** null when metrics are not available for this pod. */
  cpuMilli: number | null;
  memoryMiB: number | null;
  ageSeconds: number;
  owner: { kind: string; name: string } | null;
  labels: Record<string, string>;
  /** Set while the cluster reconnects: seconds since the last update. */
  staleSeconds?: number;
}

/** Result of SelfSubjectAccessReview for the current view, shown in the status bar. */
export interface AccessSummary {
  user: string;
  verb: string;
  resource: string;
  namespace: string;
  allowed: boolean;
}

export interface DeploymentRow {
  id: string;
  name: string;
  namespace: string;
  cluster: string;
  env: Environment;
  health: Health;
  /** Available · Degraded · Progressing */
  status: string;
  /** Rollout state: Complete · Progressing · Stalled · Paused · Degraded. */
  rollout: string;
  /** Condition behind the state, e.g. "Available=False: MinimumReplicasUnavailable". */
  reason: string;
  since?: string;
  /** Image tag of the main container. */
  image: string;
  hpa?: { name: string; min: number; max: number };
  argoApp?: string;
  revisions: { rev: number; image: string; age: string; sync?: string }[];
  usage?: { cpuMilli: number; cpuRequestMilli: number; memoryMiB: number; memoryLimitMiB: number };
  readyReplicas: number;
  replicas: number;
  updatedReplicas: number;
  availableReplicas: number;
  strategy: { type: "RollingUpdate"; maxSurge: string; maxUnavailable: string } | { type: "Recreate" };
  ageSeconds: number;
}

export interface ContainerStatus {
  name: string;
  health: Health;
  state: string;
  ready: boolean;
  restarts: number;
  image?: string;
  lastState?: string;
  memory?: string;
}

export interface ResourceEvent {
  type: "Normal" | "Warning";
  reason: string;
  message: string;
  count: number;
  lastSeen: string;
  /** Involved object relative to the inspected one: "pod" or e.g. "deploy/checkout-api". */
  object: string;
}

export interface MetricSeries {
  /** Where the samples came from, shown next to the chart. */
  source: string;
  /** Unix seconds. */
  timestamps: number[];
  values: number[];
  limit?: number;
  request?: number;
  /** Timestamps of OOMKilled terminations, drawn as markers. */
  markers?: number[];
}

export interface PodDetail {
  pod: PodRow;
  problem: { title: string; container: string; detail: string } | null;
  containers: ContainerStatus[];
  events: ResourceEvent[];
  memory: { container: string; series: MetricSeries } | null;
  ownerChain: { kind: string; name: string; note: string; tone?: Health }[];
  /** Related tab: one relation per line, with how it was found. */
  relations: PodRelation[];
}

export interface PodRelation {
  label: "Owned by" | "Selected by" | "Uses" | "Runs on" | "Disruption" | "Managed by";
  /** Kind shorthand + name, e.g. "svc/checkout-api". */
  objects: { kind: string; name: string }[];
  pill?: { text: string; tone: "warning" | "info" };
  /** How Clustrail found it: ownerReferences, selector, volume, nodeName, labels. */
  via: string;
}
