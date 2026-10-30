// The only way the UI reaches clusters: calls into the Go Workspace service
// and events it emits. Running in a plain browser (vite dev) there is no Go
// side, so the app falls back to the mock data layer.
import { Call, Events } from "@wailsio/runtime";
import type { Cluster, DeploymentRow, Environment, PodDetail, PodRow, ResourceEvent } from "@/data/types";
import type { NodeRow } from "@/data/nodes";
import type { HelmRelease } from "@/data/helm";
import type { GitOpsObject, GitOpsTool } from "@/data/gitops";

const SERVICE = "github.com/mihnk/clustrail/internal/app.Workspace.";

function call<T>(method: string, ...args: unknown[]): Promise<T> {
  return Call.ByName(SERVICE + method, ...args) as Promise<T>;
}

export interface KubeconfigSourceInfo {
  path: string;
  resolved?: string;
  contexts: number;
  watched: boolean;
  changed?: string;
  error?: string;
}

export interface ForbiddenInfo {
  cluster: string;
  namespace: string;
  user: string;
  resource: string;
}

export interface ControllerInfo {
  cluster: string;
  env: Environment;
  tool: GitOpsTool | null;
  version?: string;
  url?: string;
}

export interface ClusterList {
  clusters: Cluster[];
  discovered: Cluster[];
  sources: KubeconfigSourceInfo[];
  forbidden: ForbiddenInfo[];
  controllers: ControllerInfo[];
  selected: string[];
}

export interface Snapshot {
  clusters: Cluster[];
  pods: PodRow[];
  deployments: DeploymentRow[];
  nodes: NodeRow[];
  helm: HelmRelease[];
  gitops: GitOpsObject[];
}

export type DeltaKind = "pods" | "deployments" | "nodes" | "helm" | "gitops";

export interface Delta {
  cluster: string;
  kind: DeltaKind;
  upserts: unknown[];
  deletes: string[];
  reset?: boolean;
}

export interface JobEvent {
  id: string;
  title: string;
  progress: number;
  detail: string;
  done?: boolean;
  error?: string;
}

export interface DrainOptions {
  force: boolean;
  deleteEmptyDir: boolean;
  timeoutSec: number;
}

export interface DrainPlan {
  evict: string[];
  daemonSet: string[];
  unmanaged: string[];
  emptyDir: string[];
  blocked?: string;
  /** Pods whose PodDisruptionBudget allows no disruption now. */
  pdbBlocked: string[];
  pdb?: string;
}

export interface LiveObjectInfo {
  yaml: string;
  resourceVersion: string;
  gitops?: { tool: GitOpsTool; app: string; selfHeal: boolean; source: string };
  owners: Record<string, string>;
  apiVersion: string;
}

export interface ApplyResult {
  dryRun: boolean;
  resourceVersion: string;
  conflict?: string;
  warnings: string[];
}

export interface LogsRequest {
  cluster: string;
  namespace: string;
  pods: string[];
  containers: string[];
  previous: boolean;
  sinceSeconds: number;
  tailLines: number;
}

export interface BackendLogLine {
  pod: string;
  container: string;
  ts: string;
  level: "INFO" | "WARN" | "ERROR" | "";
  msg: string;
  event?: "failed" | "progressing" | "unknown";
}

export interface LogBatch {
  id: string;
  lines: BackendLogLine[];
  states?: { pod: string; container: string; state: "live" | "reconnecting" | "ended"; note?: string }[];
}

export interface ExecRequest {
  cluster: string;
  namespace: string;
  pod: string;
  container: string;
  command: string[];
  cols: number;
  rows: number;
}

export interface ExecOutput {
  id: string;
  data?: string;
  exit?: number;
  error?: string;
}

/** Turns a Wails RuntimeError into the Go error text. */
export function errorText(e: unknown): string {
  if (e instanceof Error) {
    try {
      const parsed = JSON.parse(e.message) as { message?: string };
      if (parsed.message) return parsed.message;
    } catch {
      // plain text
    }
    return e.message;
  }
  return String(e);
}

export const backendApi = {
  hello: () => call<{ version: string; user: string }>("Hello"),
  clusters: () => call<ClusterList>("Clusters"),
  snapshot: () => call<Snapshot>("Snapshot"),
  connect: (id: string) => call<void>("Connect", id),
  disconnect: (id: string) => call<void>("Disconnect", id),
  hideCluster: (id: string) => call<void>("HideCluster", id),
  setSelected: (ids: string[]) => call<void>("SetSelected", ids),
  autoConnect: () => call<void>("AutoConnect"),
  namespaces: (cluster: string) => call<string[]>("Namespaces", cluster),
  updateCluster: (id: string, env: Environment, prot: boolean, readOnly: boolean) => call<void>("UpdateCluster", id, env, prot, readOnly),
  addCluster: (id: string, env: Environment, prot: boolean, readOnly: boolean) => call<void>("AddCluster", id, env, prot, readOnly),

  testConnection: (id: string) => call<{ name: string; result: "ok" | "failed" | "skipped"; detail?: string; ms?: number }[]>("TestConnection", id),

  podDetail: (cluster: string, ns: string, name: string) => call<PodDetail>("PodDetail", cluster, ns, name),
  events: (cluster: string, ns: string, kind: string, name: string) => call<ResourceEvent[]>("Events", cluster, ns, kind, name),
  deletePod: (cluster: string, ns: string, name: string) => call<void>("DeletePod", cluster, ns, name),
  restartDeployment: (cluster: string, ns: string, name: string) => call<void>("RestartDeployment", cluster, ns, name),
  scaleDeployment: (cluster: string, ns: string, name: string, replicas: number) => call<void>("ScaleDeployment", cluster, ns, name, replicas),
  rollbackDeployment: (cluster: string, ns: string, name: string, rev: number) => call<void>("RollbackDeployment", cluster, ns, name, rev),
  setDeploymentPaused: (cluster: string, ns: string, name: string, paused: boolean) => call<void>("SetDeploymentPaused", cluster, ns, name, paused),
  deleteDeployment: (cluster: string, ns: string, name: string) => call<void>("DeleteDeployment", cluster, ns, name),
  setNodeCordoned: (cluster: string, node: string, cordoned: boolean) => call<void>("SetNodeCordoned", cluster, node, cordoned),
  previewDrain: (cluster: string, node: string, opts: DrainOptions) => call<DrainPlan>("PreviewDrain", cluster, node, opts),
  drainNode: (cluster: string, node: string, opts: DrainOptions) => call<string>("DrainNode", cluster, node, opts),

  getObject: (cluster: string, kind: string, ns: string, name: string) => call<LiveObjectInfo>("GetObject", cluster, kind, ns, name),
  applyYaml: (cluster: string, text: string, openedVersion: string, dryRun: boolean, force: boolean) =>
    call<ApplyResult>("ApplyYAML", cluster, text, openedVersion, dryRun, force),

  rollbackRelease: (cluster: string, ns: string, name: string, rev: number) => call<string>("RollbackRelease", cluster, ns, name, rev),
  refreshGitOps: (cluster: string, kind: string, ns: string, name: string) => call<void>("RefreshGitOps", cluster, kind, ns, name),
  syncGitOps: (cluster: string, kind: string, ns: string, name: string) => call<void>("SyncGitOps", cluster, kind, ns, name),
  setGitOpsSuspended: (cluster: string, kind: string, ns: string, name: string, suspended: boolean) =>
    call<void>("SetGitOpsSuspended", cluster, kind, ns, name, suspended),

  startLogs: (req: LogsRequest) => call<string>("StartLogs", req),
  stopLogs: (id: string) => call<void>("StopLogs", id),
  startExec: (req: ExecRequest) => call<string>("StartExec", req),
  execInput: (id: string, data: string) => call<void>("ExecInput", id, data),
  execResize: (id: string, cols: number, rows: number) => call<void>("ExecResize", id, cols, rows),
  closeExec: (id: string) => call<void>("CloseExec", id),
};

export type BackendApi = typeof backendApi;

/** Subscribes to a backend event; returns the unsubscribe function. */
export function onEvent<T>(name: string, fn: (data: T) => void): () => void {
  return Events.On(name, (ev: { data: unknown }) => fn(ev.data as T));
}

export const EVENTS = {
  delta: "clustrail:delta",
  clusters: "clustrail:clusters",
  job: "clustrail:job",
  logs: "clustrail:logs",
  exec: "clustrail:exec",
} as const;

/** Set once at startup: the Go backend when running in the desktop app, else null (mock data). */
export let backend: BackendApi | null = null;
export let backendInfo: { version: string; user: string } | null = null;

/**
 * Probes the Go side; resolves quickly to mock mode in a plain browser. The
 * desktop webview serves the UI from its own origin (wails://, wails.localhost);
 * vite on localhost:<port> has no backend, so it is not probed.
 */
export async function detectBackend(timeoutMs = 1500): Promise<boolean> {
  const devServer = /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(window.location.origin);
  if (devServer && !new URLSearchParams(window.location.search).has("backend")) return false;
  try {
    const info = await Promise.race([
      backendApi.hello(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    backend = backendApi;
    backendInfo = info;
    return true;
  } catch {
    return false;
  }
}
