// The only way the UI reaches clusters: calls into the Go Workspace service
// and events it emits. Running in a plain browser (vite dev) there is no Go
// side, so the app falls back to the mock data layer.
import { Browser, Call, Events } from "@wailsio/runtime";
import type { Cluster, DeploymentRow, Environment, PodDetail, PodRelation, PodRow, ResourceEvent } from "@/data/types";
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
  /** The one namespace listed instead, when RBAC allows it there. */
  shown?: string;
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
  /** Secrets: keys and sizes; the YAML holds "(hidden, N bytes)" in place of each value. */
  secret?: { type: string; keys: { key: string; bytes: number }[] };
}

export interface ApplyResult {
  dryRun: boolean;
  resourceVersion: string;
  conflict?: string;
  warnings: string[];
}

export interface KindInfo {
  kind: string;
  group: string;
  version: string;
  resource: string;
  namespaced: boolean;
  shortNames?: string[];
  delete: boolean;
}

export interface TableColumn {
  name: string;
  type: string;
  description?: string;
  /** > 0: kubectl shows it only with -o wide. */
  priority: number;
}

export interface GenericRow {
  id: string;
  cluster: string;
  namespace?: string;
  name: string;
  /** RFC 3339 */
  created?: string;
  labels?: Record<string, string>;
  cells: string[];
}

export interface GenericList {
  cluster: string;
  kind: string;
  namespaced: boolean;
  columns: TableColumn[];
  rows: GenericRow[];
  truncated?: boolean;
  shown?: string;
}

export interface LatencySummary {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** The Go side's pipeline and process numbers (internal/app/pods.go). */
export interface BackendDiagnostics {
  process: { cpuPercent: number; heapAllocMB: number; heapInuseMB: number; sysMB: number; totalAllocMB: number; numGC: number; gcPauseMs: number; gcCPU: number; goroutines: number };
  watches: number;
  consumers: number;
  rows: number;
  pending: number;
  events: number;
  frames: number;
  bytes: number;
  snapshots: number;
  sendFull: number;
  resyncs: number;
  maxBatch: number;
  queue: LatencySummary;
  encode: LatencySummary;
  round: LatencySummary;
  ui: LatencySummary;
  visible: LatencySummary;
  size: LatencySummary;
  at: number;
}

export interface ListUpdate {
  id: string;
  cluster: string;
  reset?: boolean;
  columns?: TableColumn[];
  namespaced: boolean;
  shown?: string;
  truncated?: boolean;
  upserts: GenericRow[];
  deletes: string[];
  error?: string;
  mode: "watch" | "poll";
}

export interface CreateResult {
  kind: string;
  name: string;
  namespace?: string;
  status: "created" | "valid" | "exists" | "failed" | "skipped";
  error?: string;
}

export interface PortForwardRequest {
  cluster: string;
  namespace: string;
  kind: "Pod" | "Service" | "Deployment";
  name: string;
  /** Service port for Services, else a container port. */
  port: number;
  /** 0 picks a free port. */
  localPort: number;
}

export interface PortForwardInfo {
  id: string;
  cluster: string;
  namespace: string;
  kind: string;
  name: string;
  port: number;
  localPort: number;
  pod?: string;
  podPort?: number;
  state: "starting" | "active" | "reconnecting" | "failed";
  error?: string;
  started: string;
}

/** A log source: a workload ("Deployment/api"), a label selector or fixed pods, in one namespace. */
export interface LogSourceSpec {
  namespace: string;
  workload?: string;
  selector?: string;
  pods?: string[];
}

export interface LogsRequest {
  cluster: string;
  namespace: string;
  pods: string[];
  /** Replace namespace/pods when set. */
  sources?: LogSourceSpec[];
  containers: string[];
  previous: boolean;
  sinceSeconds: number;
  tailLines: number;
  /** At most this many pods are followed (default 30); the newest win. */
  maxPods?: number;
  /** Pods that start matching a selector later join the stream. */
  followNew?: boolean;
}

export interface BackendLogLine {
  namespace?: string;
  pod: string;
  container: string;
  ts: string;
  level: "INFO" | "WARN" | "ERROR" | "";
  msg: string;
  event?: "failed" | "progressing" | "unknown" | "joined" | "left";
}

export interface LogPodInfo {
  namespace: string;
  pod: string;
  state: "following" | "left";
  joined?: string;
  left?: string;
  reason?: string;
  revision?: string;
  initial: boolean;
}

export interface LogBatch {
  id: string;
  lines: BackendLogLine[];
  states?: { namespace?: string; pod: string; container: string; state: "live" | "reconnecting" | "ended"; note?: string }[];
  pods?: LogPodInfo[];
  matched?: number;
  skipped?: number;
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

// Workloads (internal/kube/workloads.go).
export interface JobAttempt {
  pod: string;
  phase: string;
  health: "failed" | "progressing" | "completed" | "unknown";
  reason?: string;
  exitCode?: number;
  started?: string;
  duration?: string;
  node?: string;
}

export interface JobStatus {
  succeeded: number;
  failed: number;
  active: number;
  completions: number;
  backoffLimit: number;
  condition?: string;
  reason?: string;
  message?: string;
  attempts: JobAttempt[];
  missing: number;
}

// Warnings, access and expiry (internal/kube/insights.go).
export interface WarningEvent {
  namespace?: string;
  kind: string;
  name: string;
  reason: string;
  message: string;
  count: number;
  firstSeen?: string;
  lastSeen: string;
  source?: string;
}

export interface WarningList {
  cluster: string;
  scope: string;
  events: WarningEvent[];
}

export interface AccessSubject {
  kind: "" | "User" | "Group" | "ServiceAccount";
  name: string;
  namespace?: string;
}

export interface AccessResult {
  subject: AccessSubject;
  user: string;
  groups: string[];
  namespace: string;
  verbs: string[];
  resources: { group: string; resource: string; subresource?: string; label: string; namespaced: boolean }[];
  allowed: ("yes" | "no" | "n/a" | "error")[][];
  bindings: { kind: string; name: string; namespace?: string; role: string; via: string }[];
  bindingsNote?: string;
}

export interface ExpiryItem {
  source: "kubeconfig" | "apiserver" | "secret";
  what: string;
  namespace?: string;
  name?: string;
  subject?: string;
  issuer?: string;
  dnsNames?: string[];
  notAfter: string;
  daysLeft: number;
}

export interface ExpiryReport {
  cluster: string;
  items: ExpiryItem[];
  notes: string[];
}

// Helm upgrade (internal/kube/helm_upgrade.go).
export interface HelmUpgradeRequest {
  cluster: string;
  namespace: string;
  name: string;
  values: string;
  repo?: string;
  version?: string;
  wait: boolean;
  atomic: boolean;
  timeoutSec: number;
}

export interface HelmUpgradeSource {
  chart: string;
  version: string;
  appVersion: string;
  revision: number;
  values: string;
  defaults: string;
  versions: { repo: string; version: string; appVersion?: string }[];
  versionsNote?: string;
}

export interface HelmObjectChange {
  kind: string;
  name: string;
  namespace?: string;
  change: "changed" | "added" | "removed" | "unchanged";
  before?: string;
  after?: string;
}

export interface HelmUpgradePlan {
  chart: string;
  version: string;
  appVersion: string;
  objects: HelmObjectChange[];
  hooks: number;
  notes?: string;
  valueKeys: string[];
}

// Storage (internal/kube/storage.go).
export interface StorageClaim {
  id: string;
  namespace: string;
  name: string;
  phase: string;
  health: "healthy" | "warning" | "failed" | "terminating";
  volume?: string;
  class?: string;
  requested: string;
  capacity?: string;
  accessModes: string[];
  volumeMode?: string;
  created: string;
  pods: { name: string; phase: string; node?: string; owner?: string }[];
  reason?: string;
  usedBytes?: number;
  capacityBytes?: number;
}

export interface StorageVolume {
  name: string;
  phase: string;
  health: "healthy" | "warning" | "failed" | "idle" | "unknown";
  capacity: string;
  class?: string;
  claim?: string;
  reclaimPolicy: string;
  accessModes: string[];
  source: string;
  created: string;
  reason?: string;
}

export interface StorageClassInfo {
  name: string;
  provisioner: string;
  reclaimPolicy: string;
  bindingMode: string;
  expansion: boolean;
  default: boolean;
  claims: number;
}

export interface StorageReport {
  cluster: string;
  scope: string;
  claims: StorageClaim[];
  volumes: StorageVolume[];
  classes: StorageClassInfo[];
  usage: string;
  notes: string[];
}

// Network policies (internal/kube/netpol.go).
export interface NetPolRule {
  policy: string;
  rule: number;
  peers: string;
  ports: string;
  pods: number;
}

export interface NetPolDirection {
  isolated: boolean;
  policies: string[];
  rules: NetPolRule[];
}

export interface NetPolView {
  namespace: string;
  pod: string;
  labels: Record<string, string>;
  ingress: NetPolDirection;
  egress: NetPolDirection;
  plugin: string;
  enforced: "yes" | "no" | "unknown";
  all: string[];
}

export interface ConnectionCheck {
  allowed: boolean;
  egress: boolean;
  egressVia: string;
  ingress: boolean;
  ingressVia: string;
}

// Service chain (internal/kube/servicechain.go).
export interface ChainCheck {
  status: "ok" | "warning" | "error" | "info";
  /** English, filled in; the UI shows template with args, translated. */
  text: string;
  template: string;
  args?: string[];
  /** Data (pod names, event messages) unless hintTemplate is set. */
  hint?: string;
  hintTemplate?: string;
  hintArgs?: string[];
}

export interface ChainService {
  name: string;
  found: boolean;
  type?: string;
  clusterIP?: string;
  external?: string;
  selector: string;
  ports: { name?: string; port: number; targetPort: string; protocol: string }[];
  ready: string[];
  notReady: string[];
  pods: { name: string; phase: string; ready: boolean; ip?: string; node?: string; reason?: string }[];
  ingresses: string[];
}

export interface ServiceChain {
  cluster: string;
  namespace: string;
  ingress?: {
    name: string;
    class?: string;
    controller?: string;
    controllerPods: number;
    routes: { host: string; path: string; service: string; port: string }[];
    tls: { secret: string; hosts: string[]; found: boolean; daysLeft?: number }[];
    address: string[];
  };
  services: ChainService[];
  checks: ChainCheck[];
  verdict: ChainCheck;
}

// Debugging (internal/kube/debug.go).
export interface DebugRequest {
  cluster: string;
  namespace: string;
  pod: string;
  image: string;
  target: string;
  profile: string;
  command: string[];
}

export interface NodeShellRequest {
  cluster: string;
  node: string;
  namespace: string;
  image: string;
}

export interface NodeShellInfo {
  namespace: string;
  pod: string;
  container: string;
  command: string[];
}

// First-run setup (internal/kube/setup.go).
export interface SetupLocation {
  path: string;
  via: "default" | "env" | "added";
  state: "found" | "missing" | "invalid" | "unset";
  error?: string;
  contexts: number;
}
export interface SetupContext {
  id: string;
  name: string;
  cluster: string;
  server: string;
  auth: string;
  source: string;
  current: boolean;
  /** Stored or suggested; "" when the user must choose. */
  env: Environment | "";
  hint?: { word: string; field: "context" | "cluster" | "server" };
  stored: boolean;
  protected: boolean;
  readOnly: boolean;
  known: boolean;
}
export interface SetupInfo {
  needed: boolean;
  locations: SetupLocation[];
  contexts: SetupContext[];
}
export interface TestStepResult {
  name: string;
  result: "ok" | "failed" | "skipped";
  detail?: string;
  ms?: number;
}
export interface SetupTestResult {
  steps: TestStepResult[];
  state: "connected" | "auth" | "unreachable" | "failed";
  hint?: string;
}
export interface SetupChoice {
  id: string;
  env: Environment;
  protected: boolean;
  readOnly: boolean;
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

  addKubeconfig: () => call<string>("AddKubeconfig"),
  helmRepositories: () => call<{ name: string; url: string }[]>("HelmRepositories"),
  checkForUpdates: () => call<{ current: string; latest: string; url: string; upToDate: boolean }>("CheckForUpdates"),
  setMetricsInterval: (seconds: number) => call<void>("SetMetricsInterval", seconds),
  setUpdateMethod: (method: "watch" | "poll") => call<void>("SetUpdateMethod", method),
  setCacheBudget: (mb: number) => call<void>("SetCacheBudget", mb),
  memoryStats: () => call<{ heapMB: number; budgetMB: number; objects: Record<string, number> }>("MemoryStats"),
  pauseWatches: () => call<string[]>("PauseWatches"),
  resumeWatches: () => call<void>("ResumeWatches"),
  logFile: () => call<{ path: string; size: number }>("LogFile"),
  diagnostics: () => call<BackendDiagnostics>("Diagnostics"),
  resetDiagnostics: () => call<void>("ResetDiagnostics"),
  benchConfig: () => call<Record<string, string> | null>("BenchConfig"),
  reportBench: (result: string) => call<void>("ReportBench", result),
  setSyntheticPaused: (on: boolean) => call<void>("SetSyntheticPaused", on),
  podChecksum: (cluster: string) => call<{ count: number; sum: number }>("PodChecksum", cluster),
  revealLog: () => call<void>("RevealLog"),
  testConnection: (id: string) => call<{ name: string; result: "ok" | "failed" | "skipped"; detail?: string; ms?: number }[]>("TestConnection", id),
  setup: () => call<SetupInfo>("Setup"),
  setupTest: (id: string) => call<SetupTestResult>("SetupTest", id),
  pasteKubeconfig: (text: string) => call<string>("PasteKubeconfig", text),
  skipSetup: () => call<void>("SkipSetup"),
  restartSetup: () => call<void>("RestartSetup"),
  completeSetup: (choices: SetupChoice[], selected: string[]) => call<void>("CompleteSetup", choices, selected),

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
  revealSecretKey: (cluster: string, ns: string, name: string, key: string) =>
    call<{ value: string; binary: boolean }>("RevealSecretKey", cluster, ns, name, key),
  applyYaml: (cluster: string, text: string, openedVersion: string, dryRun: boolean, force: boolean) =>
    call<ApplyResult>("ApplyYAML", cluster, text, openedVersion, dryRun, force),

  resourceKinds: (cluster: string) => call<KindInfo[]>("ResourceKinds", cluster),
  listResources: (cluster: string, kind: string, namespace: string) => call<GenericList>("ListResources", cluster, kind, namespace),
  deleteResource: (cluster: string, kind: string, ns: string, name: string) => call<void>("DeleteResource", cluster, kind, ns, name),
  startListWatch: (cluster: string, kind: string, namespace: string) => call<string>("StartListWatch", cluster, kind, namespace),
  stopListWatch: (id: string) => call<void>("StopListWatch", id),
  createObjects: (cluster: string, text: string, dryRun: boolean) => call<CreateResult[]>("CreateObjects", cluster, text, dryRun),

  deploymentRelations: (cluster: string, ns: string, name: string) => call<PodRelation[]>("DeploymentRelations", cluster, ns, name),
  helmRevision: (cluster: string, ns: string, name: string, rev: number) =>
    call<{ rev: number; manifest: string; values: string; computed: string; hooks: { name: string; kind: string; events: string[] }[] }>("HelmRevision", cluster, ns, name, rev),
  rollbackRelease: (cluster: string, ns: string, name: string, rev: number) => call<string>("RollbackRelease", cluster, ns, name, rev),
  refreshGitOps: (cluster: string, kind: string, ns: string, name: string) => call<void>("RefreshGitOps", cluster, kind, ns, name),
  syncGitOps: (cluster: string, kind: string, ns: string, name: string) => call<void>("SyncGitOps", cluster, kind, ns, name),
  setGitOpsSuspended: (cluster: string, kind: string, ns: string, name: string, suspended: boolean) =>
    call<void>("SetGitOpsSuspended", cluster, kind, ns, name, suspended),

  startPortForward: (req: PortForwardRequest) => call<PortForwardInfo>("StartPortForward", req),
  stopPortForward: (id: string) => call<void>("StopPortForward", id),
  portForwards: () => call<PortForwardInfo[]>("PortForwards"),
  forwardablePorts: (cluster: string, kind: string, ns: string, name: string) =>
    call<{ port: number; name?: string; detail?: string }[]>("ForwardablePorts", cluster, kind, ns, name),

  restartWorkload: (cluster: string, kind: string, ns: string, name: string) => call<void>("RestartWorkload", cluster, kind, ns, name),
  scaleWorkload: (cluster: string, kind: string, ns: string, name: string, replicas: number) => call<void>("ScaleWorkload", cluster, kind, ns, name, replicas),
  workloadReplicas: (cluster: string, kind: string, ns: string, name: string) => call<number>("WorkloadReplicas", cluster, kind, ns, name),
  triggerCronJob: (cluster: string, ns: string, name: string) => call<string>("TriggerCronJob", cluster, ns, name),
  setCronJobSuspended: (cluster: string, ns: string, name: string, suspended: boolean) => call<void>("SetCronJobSuspended", cluster, ns, name, suspended),
  jobStatus: (cluster: string, ns: string, name: string) => call<JobStatus>("JobStatus", cluster, ns, name),

  clusterWarnings: (cluster: string, sinceSec: number) => call<WarningList>("ClusterWarnings", cluster, sinceSec),
  warningCount: (cluster: string, sinceSec: number) => call<number>("WarningCount", cluster, sinceSec),
  accessMatrix: (cluster: string, subject: AccessSubject, namespace: string) => call<AccessResult>("AccessMatrix", cluster, subject, namespace),
  expiry: (cluster: string) => call<ExpiryReport>("Expiry", cluster),

  helmUpgradeSource: (cluster: string, ns: string, name: string) => call<HelmUpgradeSource>("HelmUpgradeSource", cluster, ns, name),
  planHelmUpgrade: (req: HelmUpgradeRequest) => call<HelmUpgradePlan>("PlanHelmUpgrade", req),
  upgradeRelease: (req: HelmUpgradeRequest) => call<string>("UpgradeRelease", req),
  storage: (cluster: string) => call<StorageReport>("Storage", cluster),
  serviceChain: (cluster: string, ns: string, kind: string, name: string) => call<ServiceChain>("ServiceChain", cluster, ns, kind, name),
  podNetworkPolicies: (cluster: string, ns: string, pod: string) => call<NetPolView>("PodNetworkPolicies", cluster, ns, pod),
  checkConnection: (cluster: string, srcNS: string, srcPod: string, dstNS: string, dstPod: string, dstIP: string, port: number, protocol: string) =>
    call<ConnectionCheck>("CheckConnection", cluster, srcNS, srcPod, dstNS, dstPod, dstIP, port, protocol),

  addDebugContainer: (req: DebugRequest) => call<{ namespace: string; pod: string; container: string }>("AddDebugContainer", req),
  startNodeShell: (req: NodeShellRequest) => call<NodeShellInfo>("StartNodeShell", req),
  deleteNodeShell: (cluster: string, ns: string, pod: string) => call<void>("DeleteNodeShell", cluster, ns, pod),

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
  portForwards: "clustrail:portforwards",
  list: "clustrail:list",
  notice: "clustrail:notice",
} as const;

/** Opens a URL in the system browser (desktop) or a new tab (browser preview). */
export function openExternal(url: string): void {
  if (backend) void Browser.OpenURL(url);
  else window.open(url, "_blank", "noopener");
}

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
