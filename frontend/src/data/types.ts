// View models the UI renders. In the desktop build these are produced by
// the Go backend (client-go informers -> resource cache -> Wails bindings);
// the frontend never talks to a Kubernetes API server itself.

export type Environment = "prod" | "stg" | "dev";

export type ConnectionState = "connected" | "reconnecting" | "disconnected";

/** Health category. Every category has its own glyph silhouette. */
export type Health =
  | "failed"
  | "warning"
  | "progressing"
  | "healthy"
  | "completed"
  | "terminating"
  | "unknown";

export interface Cluster {
  /** kubeconfig context name. */
  id: string;
  name: string;
  env: Environment;
  /** Clustrail protection (client-side). Never a substitute for RBAC. */
  protected: boolean;
  connection: ConnectionState;
  latencyMs: number | null;
  /** From server version and node labels, e.g. "EKS 1.30 · eu-west-1". Unknown until connected. */
  summary: string | null;
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
}
