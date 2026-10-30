import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  clusters as initialClusters,
  deployments as initialDeployments,
  initialSelectedClusters,
  pods as initialPods,
} from "@/data/mock";
import type { Cluster, DeploymentRow, PodRow } from "@/data/types";
import { nodes as initialNodes, type NodeRow } from "@/data/nodes";
import { helmReleases as initialReleases, helmHealth, type HelmRelease } from "@/data/helm";
import { gitopsObjects as initialGitOps, gitopsHealth, type GitOpsObject } from "@/data/gitops";
import { useToast } from "@/components/ui/toast";
import { readPreference, useMediaQuery, usePersistentState, writePreference, type Density, type Theme, type ThemePreference } from "./preferences";
import { backend, type ClusterList } from "@/backend/client";
import { useDesktopWorkspace } from "./desktop";
import { resourceTab } from "@/features/resources/kinds";
import { t as tt } from "@/i18n";

export type WorkspaceTabKind =
  | "clusters"
  | "pods"
  | "deployments"
  | "nodes"
  | "resource"
  | "list"
  | "create"
  | "investigation"
  | "logs"
  | "shell"
  | "yaml"
  | "compare"
  | "helm"
  | "gitops"
  | "warnings"
  | "certificates"
  | "access"
  | "connections"
  | "settings";

export interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  title: string;
  subtitle?: string;
  /** Tabs scoped to one cluster show its environment and protection. */
  cluster?: string;
  /** View parameters, e.g. { namespace, name } for a Logs tab. */
  params?: Record<string, string>;
}

const SAVED_TABS = "workspace.desktop.tabs";
/** Tabs that reopen on launch. Streams (Logs, Shell) and unsaved drafts (Create) start fresh. */
const RESTORABLE: WorkspaceTabKind[] = ["clusters", "pods", "deployments", "nodes", "helm", "gitops", "warnings", "certificates", "access", "connections", "settings", "list", "yaml", "investigation", "compare"];
const DEFAULT_TABS: WorkspaceTab[] = [
  { id: "clusters", kind: "clusters", title: tt("Clusters") },
  { id: "pods", kind: "pods", title: tt("Pods") },
];

function launchTabs(): { tabs: WorkspaceTab[]; active: string } {
  if (readPreference<"restore" | "clusters">("settings.onLaunch", "restore") === "restore") {
    const saved = readPreference<{ tabs?: WorkspaceTab[]; active?: string } | null>(SAVED_TABS, null);
    const tabs = (saved?.tabs ?? []).filter((t) => t && typeof t.id === "string" && RESTORABLE.includes(t.kind));
    if (tabs.length) return { tabs, active: tabs.some((t) => t.id === saved?.active) ? saved!.active! : tabs[0]!.id };
  }
  return { tabs: DEFAULT_TABS, active: "clusters" };
}

/** Explorer kinds have one tab each; tool tabs (Logs, Shell, YAML, Compare) open per target. */
const SINGLETON_KINDS: WorkspaceTabKind[] = ["clusters", "pods", "nodes", "helm", "gitops", "warnings", "certificates", "access", "connections", "settings"];

export interface MockScenarios {
  /** prod-us-east-1 loses its watch: rows go stale while it retries. */
  watchLost: boolean;
  /** metrics.k8s.io missing on staging-eu-1. */
  noMetrics: boolean;
}

export interface InvestigationInfo {
  id: string;
  title: string;
}

/** The first investigation keeps the storage keys it had before there could be several. */
export const DEFAULT_INVESTIGATION = "inv-checkout-api";

/** Storage key of one investigation's evidence, hypotheses or notes. */
export function investigationKey(id: string, part: "pins" | "hypotheses" | "notes-md"): string {
  if (id === DEFAULT_INVESTIGATION) {
    if (!backend) return part === "pins" ? "investigation.checkout-api-restarts.pins" : `investigation.checkout-api-restarts.${part}`;
    return `investigation.desktop.${part}`;
  }
  return `investigation.${id}.${part}`;
}

/** Evidence pinned from Logs, Events, Terminal or Metrics into the investigation. */
export interface Pin {
  id: string;
  at: string;
  /** e.g. "Logs · checkout-api · A x2kqp". */
  source: string;
  cluster: string;
  text: string;
}

/** A long-running operation shown in a progress toast and the status bar. */
export interface BackgroundJob {
  id: string;
  title: string;
  /** 0–1 */
  progress: number;
  detail: string;
}

/** A request from another view (command palette, links) to select a resource in its explorer. */
export interface RevealRequest {
  /** "filter": id is "<view kind>:<filter text>", e.g. "pods:cluster:prod-eu-west-1". */
  kind: "pod" | "deployment" | "node" | "cluster" | "filter" | "session";
  id: string;
  seq: number;
}

export interface WorkspaceState {
  theme: Theme;
  /** The stored choice; `theme` is what it resolves to. */
  themePreference: ThemePreference;
  setTheme: (t: ThemePreference) => void;
  density: Density;
  setDensity: (d: Density) => void;

  clusters: Cluster[];
  clusterById: (id: string) => Cluster | undefined;
  selectedClusterIds: string[];
  setSelectedClusterIds: (ids: string[]) => void;
  toggleCluster: (id: string, selected: boolean) => void;
  selectedClusters: Cluster[];
  /** Pods from the selected clusters. Filtering by view happens per tab. */
  pods: PodRow[];
  /** Pods from every connected cluster, for per-cluster counts. */
  allPods: PodRow[];
  deployments: DeploymentRow[];
  nodes: NodeRow[];

  /** Connect, retry or re-authenticate a cluster (mock: simulated outcome). */
  connectCluster: (id: string) => void;
  /** Stops informers and drops the cache for this cluster; it stays listed. */
  disconnectCluster: (id: string) => void;
  /** Group and Clustrail protection, stored in Clustrail's settings (never in the kubeconfig). */
  updateCluster: (id: string, patch: Partial<Pick<Cluster, "env" | "protected" | "readOnly">>) => void;
  /** Hides the context in Clustrail; the kubeconfig file is not modified. */
  hideCluster: (id: string) => void;
  /** Adds a newly discovered context and connects to it. */
  addCluster: (c: Cluster) => void;

  // Mock mutations. In the desktop build these are requests to the Go backend;
  // the UI then follows the resulting watch events.
  deletePod: (id: string) => void;
  restartDeployment: (id: string) => void;
  scaleDeployment: (id: string, replicas: number) => void;
  rollbackDeployment: (id: string, rev: number) => void;
  setDeploymentPaused: (id: string, paused: boolean) => void;
  deleteDeployment: (id: string) => void;
  setNodeCordoned: (id: string, cordoned: boolean) => void;
  /** Cordons the node and evicts its pods in the background. */
  drainNode: (id: string, opts: { force: boolean; deleteEmptyDir: boolean; timeoutSec: number }) => void;
  helmReleases: HelmRelease[];
  /** helm rollback <release> <rev> --wait: a new revision with the target's manifest. */
  rollbackRelease: (id: string, rev: number) => void;
  gitops: GitOpsObject[];
  /** Asks the controller to re-read the source (Argo refresh annotation / Flux requestedAt). */
  refreshGitOps: (id: string) => void;
  /** Argo CD sync operation / Flux reconcile with source: the desired state wins over drift. */
  syncGitOps: (id: string) => void;
  setGitOpsSuspended: (id: string, suspended: boolean) => void;
  jobs: BackgroundJob[];
  /** Evidence of the current investigation: the one last opened. */
  pins: Pin[];
  pinToInvestigation: (pin: Omit<Pin, "id" | "at">) => void;
  clearPins: () => void;
  investigations: InvestigationInfo[];
  currentInvestigation: string;
  /** Creates an investigation, opens its tab and makes it the pin target. */
  newInvestigation: () => void;
  openInvestigation: (id: string) => void;
  renameInvestigation: (id: string, title: string) => void;
  /** Removes an investigation and its saved evidence, hypotheses and notes. */
  deleteInvestigation: (id: string) => void;

  scenarios: MockScenarios;
  setScenario: (key: keyof MockScenarios, on: boolean) => void;
  /** Simulates a slow initial list on prod-us-east-1. */
  simulateSlowList: () => void;

  tabs: WorkspaceTab[];
  activeTabId: string;
  activeTab: WorkspaceTab | undefined;
  setActiveTabId: (id: string) => void;
  /** Activates the tab if it exists; returns whether it did. */
  openTab: (id: string) => boolean;
  /** Opens (or activates) a view; returns the tab id. */
  openView: (tab: Omit<WorkspaceTab, "id"> & { id?: string }) => string;
  closeTab: (id: string) => void;
  /** ⌘⇧T */
  reopenClosedTab: () => void;

  reveal: RevealRequest | null;
  revealResource: (kind: RevealRequest["kind"], id: string) => void;

  /** Desktop mode: kubeconfig sources, new contexts, RBAC gaps and GitOps controllers from the backend. */
  backendMeta: ClusterList | null;
}

export const SYSTEM_NAMESPACES = ["kube-system", "kube-public", "kube-node-lease"];

const WorkspaceContext = createContext<WorkspaceState | null>(null);

const initialTabs: WorkspaceTab[] = [
  { id: "pods", kind: "pods", title: tt("Pods") },
  resourceTab("prod-eu-west-1", "Deployment", "payments", "checkout-api"),
  { id: "inv-checkout-api", kind: "investigation", title: tt("Investigation · checkout-api") },
  { id: "shell", kind: "shell", title: tt("Shell · 9rkzd"), cluster: "prod-eu-west-1" },
  {
    id: "yaml-checkout-api",
    kind: "yaml",
    title: tt("YAML · checkout-api"),
    cluster: "prod-eu-west-1",
    params: { kind: "Deployment", namespace: "payments", name: "checkout-api" },
  },
  {
    id: "deployments-prod-eu-west-1",
    kind: "deployments",
    title: tt("Deployments"),
    cluster: "prod-eu-west-1",
    params: { namespace: "payments" },
  },
];

const RETRY_SECONDS = 4;

// The copy is cached per row object so an unchanged pod keeps its identity
// across updates (memoized table rows and the row model rely on that).
const usageless = new WeakMap<PodRow, PodRow>();
function withoutUsage(p: PodRow): PodRow {
  if (p.cpuMilli === null && p.memoryMiB === null) return p;
  let copy = usageless.get(p);
  if (!copy) usageless.set(p, (copy = { ...p, cpuMilli: null, memoryMiB: null }));
  return copy;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [themePreference, setTheme] = usePersistentState<ThemePreference>("theme", "dark");
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const theme: Theme = themePreference === "system" ? (systemDark ? "dark" : "light") : themePreference;
  const [hideSystemNamespaces] = usePersistentState("settings.hideSystemNamespaces", true);
  const [density, setDensity] = usePersistentState<Density>("density", "default");
  // Desktop mode starts empty and fills from the backend; the selection there is the backend's.
  const desktop = backend !== null;
  const [selectedClusterIds, setSelectedClusterIds] = usePersistentState<string[]>(
    desktop ? "desktop.selectedClusters" : "selectedClusters",
    desktop ? [] : initialSelectedClusters,
  );
  const [clusters, setClusters] = useState<Cluster[]>(desktop ? [] : initialClusters);
  const [allPods, setAllPods] = useState<PodRow[]>(desktop ? [] : initialPods);
  const [deployments, setDeployments] = useState<DeploymentRow[]>(desktop ? [] : initialDeployments);
  const [nodes, setNodes] = useState<NodeRow[]>(desktop ? [] : initialNodes);
  const [helmReleases, setHelmReleases] = useState<HelmRelease[]>(desktop ? [] : initialReleases);
  const [gitops, setGitops] = useState<GitOpsObject[]>(desktop ? [] : initialGitOps);
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [investigations, setInvestigations] = usePersistentState<InvestigationInfo[]>(desktop ? "investigations.desktop" : "investigations.mock", [
    { id: DEFAULT_INVESTIGATION, title: desktop ? "Investigation" : "checkout-api restarts" },
  ]);
  const [currentInvestigation, setCurrentInvestigation] = usePersistentState<string>("investigations.current", DEFAULT_INVESTIGATION);
  const current = investigations.some((i) => i.id === currentInvestigation) ? currentInvestigation : DEFAULT_INVESTIGATION;
  const [pins, setPins] = usePersistentState<Pin[]>(investigationKey(current, "pins"), []);
  // Desktop opens the last workspace (Settings › On launch) or the clusters overview; the mock opens the design's tab set.
  const [launch] = useState(() => (desktop ? launchTabs() : { tabs: initialTabs, active: "pods" }));
  const [tabs, setTabs] = useState<WorkspaceTab[]>(launch.tabs);
  const [closedTabs, setClosedTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState(launch.active);
  // The investigation you look at last receives new pins.
  useEffect(() => {
    const t = tabs.find((x) => x.id === activeTabId);
    if (t?.kind === "investigation" && t.id !== currentInvestigation) setCurrentInvestigation(t.id);
  }, [activeTabId]);
  useEffect(() => {
    if (desktop) writePreference(SAVED_TABS, { tabs: tabs.filter((t) => RESTORABLE.includes(t.kind)), active: activeTabId });
  }, [tabs, activeTabId]);
  const [scenarios, setScenarios] = useState<MockScenarios>({ watchLost: false, noMetrics: false });
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const later = useCallback((ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, ms);
    timers.current.add(t);
  }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const patchCluster = useCallback(
    (id: string, patch: Partial<Cluster>) => setClusters((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c))),
    [],
  );

  const connectCluster = useCallback(
    (id: string) => {
      const c = clusters.find((x) => x.id === id);
      if (!c) return;
      patchCluster(id, { connection: "connecting", error: undefined });
      later(1500, () => {
        if (c.connection === "unreachable") {
          // The API server is still down: same error, newer attempt.
          patchCluster(id, { connection: "unreachable", error: c.error });
          toast.show({ kind: "error", title: tt("Still unreachable"), target: c.name, detail: c.error, copyText: c.error });
          return;
        }
        patchCluster(id, {
          connection: "connected",
          latencyMs: 20 + Math.round(Math.random() * 30),
          summary: c.summary ?? (c.env === "dev" ? tt("k3s 1.29 · dev.acme.internal") : tt("GKE 1.31 · europe-west4")),
          authHint: undefined,
          lastConnected: "now",
        });
        toast.show({ kind: "success", title: tt("Connected"), target: c.name, env: c.env });
      });
    },
    [clusters, later, patchCluster, toast],
  );

  const disconnectCluster = useCallback(
    (id: string) => {
      patchCluster(id, { connection: "disconnected", latencyMs: null, lastConnected: "now", stale: undefined });
      setSelectedClusterIds(selectedClusterIds.filter((x) => x !== id));
    },
    [patchCluster, selectedClusterIds, setSelectedClusterIds],
  );

  const hideCluster = useCallback(
    (id: string) => {
      setClusters((cs) => cs.filter((c) => c.id !== id));
      setSelectedClusterIds(selectedClusterIds.filter((x) => x !== id));
    },
    [selectedClusterIds, setSelectedClusterIds],
  );

  const addCluster = useCallback(
    (c: Cluster) => {
      setClusters((cs) => [...cs, { ...c, connection: "connecting" }]);
      later(1500, () => {
        patchCluster(c.id, { connection: "connected", latencyMs: 58, summary: tt("GKE 1.31 · europe-west4"), version: "v1.31.2", identity: "edit", lastConnected: "now" });
        toast.show({ kind: "success", title: tt("Connected"), target: c.name, env: c.env });
      });
    },
    [later, patchCluster, toast],
  );

  // Mock watch loss: the cluster retries every few seconds until the scenario is turned off.
  useEffect(() => {
    if (!scenarios.watchLost) return;
    const id = "prod-us-east-1";
    const since = Date.now();
    let attempt = 1;
    patchCluster(id, { connection: "reconnecting", stale: { since, attempt, nextRetrySec: RETRY_SECONDS } });
    const tick = setInterval(() => {
      setClusters((cs) =>
        cs.map((c) => {
          if (c.id !== id || !c.stale) return c;
          const next = c.stale.nextRetrySec - 1;
          if (next > 0) return { ...c, stale: { ...c.stale, nextRetrySec: next } };
          attempt += 1;
          return { ...c, stale: { ...c.stale, attempt, nextRetrySec: RETRY_SECONDS } };
        }),
      );
    }, 1000);
    return () => {
      clearInterval(tick);
      patchCluster(id, { connection: "connected", stale: undefined });
    };
  }, [scenarios.watchLost, patchCluster]);

  useEffect(() => {
    patchCluster("staging-eu-1", { metrics: scenarios.noMetrics ? null : "metrics-server" });
  }, [scenarios.noMetrics, patchCluster]);

  const simulateSlowList = useCallback(() => {
    patchCluster("prod-us-east-1", { connection: "connecting" });
    later(2500, () => patchCluster("prod-us-east-1", { connection: "connected" }));
  }, [later, patchCluster]);

  const deletePod = useCallback(
    (id: string) => {
      const pod = allPods.find((p) => p.id === id);
      setAllPods((ps) =>
        ps.map((p) => (p.id === id ? { ...p, health: "terminating", status: "Terminating", reason: tt("Terminating (deleted)") } : p)),
      );
      if (pod) toast.show({ kind: "success", title: tt("Pod deleted"), target: `${pod.name} · ${pod.cluster}`, env: pod.env });
      // After the grace period the pod is gone; a controller-owned pod gets a replacement.
      later(3000, () =>
        setAllPods((ps) => {
          const gone = ps.find((p) => p.id === id);
          const rest = ps.filter((p) => p.id !== id);
          if (!gone?.owner || gone.owner.kind === "Job") return rest;
          const name = `${gone.owner.name}-${Math.random().toString(36).slice(2, 7)}`;
          return [
            ...rest,
            {
              ...gone,
              id: `${gone.cluster}/${gone.namespace}/${name}`,
              name,
              health: "progressing",
              status: "Creating",
              reason: tt("ContainerCreating"),
              readyContainers: 0,
              restarts: 0,
              cpuMilli: null,
              memoryMiB: null,
              ageSeconds: 1,
            },
          ];
        }),
      );
    },
    [allPods, later, toast],
  );

  const restartDeployment = useCallback(
    (id: string) => {
      const before = deployments.find((d) => d.id === id);
      if (!before) return;
      setDeployments((ds) =>
        ds.map((d) =>
          d.id === id
            ? { ...d, health: "progressing", status: "Progressing", rollout: "Progressing", reason: tt("Rolling out: pod template restartedAt changed"), updatedReplicas: 0 }
            : d,
        ),
      );
      const tid = toast.show({
        kind: "progress",
        title: tt("Restarting rollout"),
        target: `${before.name} · ${before.cluster}`,
        env: before.env,
        progress: 0.1,
        detail: tt("0 of {replicas} pods replaced", { replicas: before.replicas }),
      });
      later(2000, () =>
        toast.update(tid, { progress: 0.55, detail: tt("{v0} of {replicas} pods replaced", { v0: Math.ceil(before.replicas / 2), replicas: before.replicas }) }),
      );
      // The rollout finishes; the Deployment returns to whatever state its pods produce.
      later(4000, () => {
        setDeployments((ds) => ds.map((d) => (d.id === id ? before : d)));
        toast.update(tid, { kind: "success", title: tt("Rollout restarted"), progress: undefined, detail: undefined });
      });
    },
    [deployments, later, toast],
  );

  const patchDeployment = useCallback(
    (id: string, patch: Partial<DeploymentRow>) => setDeployments((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d))),
    [],
  );

  const scaleDeployment = useCallback(
    (id: string, replicas: number) => {
      const d = deployments.find((x) => x.id === id);
      if (!d) return;
      patchDeployment(id, { replicas, rollout: "Progressing", health: "progressing", reason: tt("Scaling to {replicas}", { replicas }) });
      later(2500, () => {
        const ready = Math.min(replicas, d.readyReplicas + Math.max(0, replicas - d.replicas));
        patchDeployment(id, {
          replicas,
          readyReplicas: ready,
          availableReplicas: ready,
          updatedReplicas: replicas,
          ...(ready < replicas
            ? { health: "failed" as const, status: "Degraded", rollout: "Degraded", reason: d.reason }
            : { health: "healthy" as const, status: "Available", rollout: "Complete", reason: tt("Available, rollout complete") }),
        });
        // With an HPA, the controller sets replicas back within its range.
        if (d.hpa && (replicas < d.hpa.min || replicas > d.hpa.max)) {
          later(3000, () => patchDeployment(id, { replicas: d.replicas }));
          toast.show({ kind: "error", title: tt("Scale overridden by HPA"), target: `${d.name} · ${d.cluster}`, detail: tt("HPA {name} keeps replicas between {min} and {max}.", { name: d.hpa.name, min: d.hpa.min, max: d.hpa.max }) });
        } else {
          toast.show({ kind: "success", title: tt("Scaled to {replicas}", { replicas }), target: `${d.name} · ${d.cluster}`, env: d.env });
        }
      });
    },
    [deployments, later, patchDeployment, toast],
  );

  const rollbackDeployment = useCallback(
    (id: string, rev: number) => {
      const d = deployments.find((x) => x.id === id);
      const target = d?.revisions.find((r) => r.rev === rev);
      if (!d || !target) return;
      const next = Math.max(...d.revisions.map((r) => r.rev)) + 1;
      patchDeployment(id, {
        health: "progressing",
        rollout: "Progressing",
        reason: tt("Rolling back to revision {rev}", { rev }),
        image: target.image,
        updatedReplicas: 0,
        revisions: [{ ...target, rev: next, age: "now" }, ...d.revisions.filter((r) => r.rev !== rev)],
      });
      later(4000, () => patchDeployment(id, { updatedReplicas: d.replicas, rollout: d.readyReplicas < d.replicas ? "Degraded" : "Complete", health: d.health, reason: d.reason }));
      toast.show({ kind: "success", title: tt("Rolled back to revision {rev}", { rev }), target: `${d.name} · ${d.cluster}`, env: d.env });
    },
    [deployments, later, patchDeployment, toast],
  );

  const rollbackRelease = useCallback(
    (id: string, rev: number) => {
      const r = helmReleases.find((x) => x.id === id);
      const target = r?.history.find((h) => h.rev === rev);
      if (!r || !target) return;
      const next = r.revision + 1;
      const patch = (p: Partial<HelmRelease>) => setHelmReleases((rs) => rs.map((x) => (x.id === id ? { ...x, ...p } : x)));
      patch({
        status: "pending-rollback",
        health: helmHealth("pending-rollback"),
        revision: next,
        updatedSeconds: 0,
        history: [
          { ...target, rev: next, status: "pending-rollback", updatedSeconds: 0, description: tt("Rollback to {rev}", { rev }) },
          ...r.history.map((h) => (h.status === "deployed" ? { ...h, status: "superseded" as const } : h)),
        ],
      });
      const jobId = `helm-${id}-${next}`;
      setJobs((js) => [...js, { id: jobId, title: tt("Rolling back {name}", { name: r.name }), progress: 0.3, detail: tt("waiting for resources · {cluster}", { cluster: r.cluster }) }]);
      later(3500, () => {
        setJobs((js) => js.filter((j) => j.id !== jobId));
        setHelmReleases((rs) =>
          rs.map((x) =>
            x.id !== id
              ? x
              : {
                  ...x,
                  status: "deployed",
                  health: "healthy",
                  chartVersion: target.chartVersion,
                  appVersion: target.appVersion,
                  history: x.history.map((h) => (h.rev === next ? { ...h, status: "deployed", description: tt("Rollback to {rev}", { rev }) } : h)),
                },
          ),
        );
        toast.show({ kind: "success", title: tt("Rolled back to revision {rev}", { rev }), target: `${r.name} · ${r.cluster}`, env: r.env, detail: tt("now revision {next}", { next }) });
      });
    },
    [helmReleases, later, toast],
  );

  const patchGitOps = useCallback(
    (id: string, p: Partial<GitOpsObject> | ((o: GitOpsObject) => Partial<GitOpsObject>)) =>
      setGitops((os) =>
        os.map((o) => {
          if (o.id !== id) return o;
          const next = { ...o, ...(typeof p === "function" ? p(o) : p) };
          return { ...next, health: gitopsHealth(next.sync, next.appHealth) };
        }),
      ),
    [],
  );

  const refreshGitOps = useCallback(
    (id: string) => {
      const o = gitops.find((x) => x.id === id);
      if (!o) return;
      patchGitOps(id, { reconciledSeconds: 0 });
      toast.show({ kind: "success", title: o.tool === "Argo CD" ? tt("Refresh requested") : tt("Reconcile requested"), target: `${o.name} · ${o.cluster}`, env: o.env });
    },
    [gitops, patchGitOps, toast],
  );

  const syncGitOps = useCallback(
    (id: string) => {
      const o = gitops.find((x) => x.id === id);
      if (!o) return;
      patchGitOps(id, { appHealth: "Progressing", reconciledSeconds: 0 });
      later(2500, () => {
        if (o.error) {
          patchGitOps(id, (cur) => ({ appHealth: o.appHealth, sync: "Failed", conditions: [{ type: "Ready=False", message: tt("ReconciliationFailed"), at: new Date().toLocaleTimeString([], { hour12: false }) }, ...cur.conditions.slice(1)] }));
          toast.show({ kind: "error", title: tt("Reconciliation failed"), target: `${o.name} · ${o.cluster}`, env: o.env, detail: o.error, copyText: o.error });
          return;
        }
        patchGitOps(id, (cur) => ({
          sync: cur.tool === "Argo CD" ? "Synced" : "Applied",
          appHealth: cur.appHealth === "Progressing" ? (o.appHealth === "Progressing" ? "Healthy" : o.appHealth) : cur.appHealth,
          drift: [],
          resources: cur.resources.map((r) => ({ ...r, status: "Synced" })),
          history: [{ revision: cur.revision, at: "now", message: tt("Sync to {revision} (from Clustrail)", { revision: cur.revision }) }, ...cur.history],
        }));
        toast.show({ kind: "success", title: o.tool === "Argo CD" ? tt("Synced") : tt("Reconciled"), target: `${o.name} · ${o.cluster}`, env: o.env, detail: `revision ${o.revision}` });
      });
    },
    [gitops, later, patchGitOps, toast],
  );

  const setGitOpsSuspended = useCallback(
    (id: string, suspended: boolean) => {
      patchGitOps(id, (o) => ({ suspended, appHealth: suspended ? "Suspended" : "Ready", sync: suspended ? o.sync : "Applied" }));
    },
    [patchGitOps],
  );

  const setNodeCordoned = useCallback(
    (id: string, cordoned: boolean) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id !== id
            ? n
            : cordoned
              ? {
                  ...n,
                  health: n.health === "healthy" ? "cordoned" : n.health,
                  status: n.health === "healthy" ? "Cordoned" : n.status,
                  reason: tt("Ready, SchedulingDisabled"),
                  cordonedBy: "you in Clustrail",
                  cordonedAgo: "now",
                  taints: [...n.taints.filter((t) => t.key !== "node.kubernetes.io/unschedulable"), { key: "node.kubernetes.io/unschedulable", effect: "NoSchedule" }],
                }
              : {
                  ...n,
                  health: n.health === "cordoned" ? "healthy" : n.health,
                  status: n.health === "cordoned" ? "Ready" : n.status,
                  reason: n.health === "cordoned" ? tt("Ready=True") : n.reason,
                  cordonedBy: undefined,
                  cordonedAgo: undefined,
                  taints: n.taints.filter((t) => t.key !== "node.kubernetes.io/unschedulable"),
                },
        ),
      );
      const n = nodes.find((x) => x.id === id);
      if (n) toast.show({ kind: "success", title: cordoned ? tt("Node cordoned") : tt("Node uncordoned"), target: `${n.name.split(".")[0]} · ${n.cluster}`, env: n.env });
    },
    [nodes, toast],
  );

  const drainNode = useCallback<WorkspaceState["drainNode"]>(
    (id, opts) => {
      const n = nodes.find((x) => x.id === id);
      if (!n) return;
      // Drain cordons first; an already cordoned node stays as it is.
      if (!n.taints.some((t) => t.key === "node.kubernetes.io/unschedulable")) setNodeCordoned(id, true);
      const short = n.name.split(".")[0]!;
      const blocked = n.name.startsWith("ip-10-42-3-17") ? 2 : 0;
      // DaemonSet pods stay on the node.
      const total = Math.max(1, n.pods - (n.cluster === "staging-eu-1" ? 3 : 5));
      const evictable = total - blocked;
      const jobId = `drain-${id}`;
      let evicted = 0;
      let elapsed = 0;
      let cancelled = false;
      const detail = () =>
        `${evicted} of ${total} evicted${blocked ? ` · ${blocked} waiting on PDB` : ""} · ${Math.max(0, opts.timeoutSec - elapsed)}s left`;
      const tid = toast.show({
        kind: "progress",
        title: tt("Draining {short}", { short }),
        env: n.env,
        progress: 0,
        detail: detail(),
        onCancel: () => {
          cancelled = true;
        },
      });
      setJobs((js) => [...js, { id: jobId, title: tt("Draining {short}", { short }), progress: 0, detail: detail() }]);
      const step = setInterval(() => {
        elapsed += 1;
        if (cancelled) {
          clearInterval(step);
          setJobs((js) => js.filter((j) => j.id !== jobId));
          toast.update(tid, { kind: "error", title: tt("Drain cancelled · {short}", { short }), progress: undefined, onCancel: undefined, detail: tt("{evicted} pods evicted. The node stays cordoned.", { evicted }) });
          return;
        }
        evicted = Math.min(evictable, evicted + 2);
        const progress = evicted / total;
        setJobs((js) => js.map((j) => (j.id === jobId ? { ...j, progress, detail: detail() } : j)));
        toast.update(tid, { progress, detail: detail() });
        // PDB-blocked pods are retried until the timeout, then reported.
        if (evicted >= evictable && (blocked === 0 || elapsed >= Math.min(opts.timeoutSec, evictable / 2 + 8))) {
          clearInterval(step);
          setJobs((js) => js.filter((j) => j.id !== jobId));
          setNodes((ns) => ns.map((x) => (x.id === id ? { ...x, pods: x.pods - evicted } : x)));
          toast.update(
            tid,
            blocked
              ? { kind: "error", title: tt("Drain incomplete · {short}", { short }), progress: undefined, onCancel: undefined, detail: tt("{blocked} pods still blocked by PodDisruptionBudget checkout-api after the timeout. The node stays cordoned.", { blocked }), copyText: `kubectl --context ${n.cluster} get pdb -A` }
              : { kind: "success", title: tt("Drained {short}", { short }), progress: undefined, onCancel: undefined, detail: tt("{evicted} pods evicted", { evicted }) },
          );
        }
      }, 1000);
    },
    [nodes, setNodeCordoned, toast],
  );

  // Watch-like updates for the mock: usage numbers move, and the cart-web
  // rollout that is in progress at start finishes after a while.
  useEffect(() => {
    const tick = setInterval(() => {
      setAllPods((ps) =>
        ps.map((p, i) =>
          p.health === "healthy" && p.cpuMilli !== null && (i + Math.floor(Date.now() / 5000)) % 9 === 0
            ? { ...p, cpuMilli: Math.max(1, Math.round(p.cpuMilli * (0.85 + Math.random() * 0.3))) }
            : p,
        ),
      );
    }, 5000);
    const done = setTimeout(
      () =>
        setDeployments((ds) =>
          ds.map((d) =>
            d.name === "cart-web" && d.cluster === "prod-us-east-1"
              ? { ...d, updatedReplicas: d.replicas, health: "healthy", status: "Available", rollout: "Complete", reason: tt("Available, rollout complete") }
              : d,
          ),
        ),
      12000,
    );
    return () => {
      clearInterval(tick);
      clearTimeout(done);
    };
  }, []);

  const desktopState = useDesktopWorkspace({
    toast,
    clusters,
    allPods,
    deployments,
    nodes,
    helmReleases,
    gitops,
    setClusters,
    setAllPods,
    setDeployments,
    setNodes,
    setHelmReleases,
    setGitops,
    setJobs,
    selectedClusterIds,
    setSelectedClusterIds,
  });

  const value = useMemo<WorkspaceState>(() => {
    const selected = new Set(selectedClusterIds);
    const clusterById = (id: string) => clusters.find((c) => c.id === id);
    const noMetrics = new Set(clusters.filter((c) => c.metrics === null).map((c) => c.id));
    const openTab = (id: string) => {
      if (!tabs.some((t) => t.id === id)) return false;
      setActiveTabId(id);
      return true;
    };
    const openView: WorkspaceState["openView"] = (spec) => {
      const existing = tabs.find((t) =>
        spec.id
          ? t.id === spec.id
          : t.kind === spec.kind &&
            (SINGLETON_KINDS.includes(spec.kind) ||
              (t.cluster === spec.cluster && JSON.stringify(t.params ?? {}) === JSON.stringify(spec.params ?? {}))),
      );
      if (existing) {
        setActiveTabId(existing.id);
        return existing.id;
      }
      const id = spec.id ?? `${spec.kind}-${Date.now().toString(36)}`;
      setTabs([...tabs, { ...spec, id }]);
      setActiveTabId(id);
      return id;
    };
    const openInvestigation = (id: string) => {
      const info = investigations.find((i) => i.id === id);
      if (info) openView({ id, kind: "investigation", title: info.title });
    };
    return {
      theme,
      themePreference,
      setTheme,
      density,
      setDensity,
      clusters,
      clusterById,
      selectedClusterIds,
      setSelectedClusterIds,
      toggleCluster: (id, on) =>
        setSelectedClusterIds(on ? [...new Set([...selectedClusterIds, id])] : selectedClusterIds.filter((c) => c !== id)),
      // Keep the sidebar order (environment groups) regardless of selection order.
      selectedClusters: clusters.filter((c) => selected.has(c.id)),
      pods: allPods
        .filter((p) => selected.has(p.cluster) && !(hideSystemNamespaces && SYSTEM_NAMESPACES.includes(p.namespace)))
        // Without metrics.k8s.io there is no usage: never show 0, show nothing.
        .map((p) => (noMetrics.has(p.cluster) ? withoutUsage(p) : p)),
      allPods,
      deployments,
      nodes,
      setNodeCordoned,
      drainNode,
      helmReleases,
      rollbackRelease,
      gitops,
      refreshGitOps,
      syncGitOps,
      setGitOpsSuspended,
      jobs,
      pins,
      clearPins: () => setPins([]),
      pinToInvestigation: (pin) => {
        setPins([...pins, { ...pin, id: `${Date.now()}`, at: new Date().toISOString() }]);
        const info = investigations.find((i) => i.id === current) ?? investigations[0]!;
        toast.show({ kind: "success", title: tt("Pinned to investigation"), target: info.title, action: { label: tt("Open investigation"), onClick: () => openInvestigation(info.id) } });
      },
      investigations,
      currentInvestigation: current,
      newInvestigation: () => {
        const id = `inv-${Date.now().toString(36)}`;
        const n = investigations.length + 1;
        const title = `Investigation ${n}`;
        setInvestigations([...investigations, { id, title }]);
        setCurrentInvestigation(id);
        setTabs([...tabs, { id, kind: "investigation", title }]);
        setActiveTabId(id);
      },
      openInvestigation,
      renameInvestigation: (id, title) => {
        setInvestigations(investigations.map((i) => (i.id === id ? { ...i, title } : i)));
        setTabs(tabs.map((t) => (t.id === id ? { ...t, title } : t)));
      },
      deleteInvestigation: (id) => {
        if (id === DEFAULT_INVESTIGATION) return;
        for (const part of ["pins", "hypotheses", "notes-md"] as const) writePreference(investigationKey(id, part), null);
        setInvestigations(investigations.filter((i) => i.id !== id));
        if (current === id) setCurrentInvestigation(DEFAULT_INVESTIGATION);
        const rest = tabs.filter((t) => t.id !== id);
        setTabs(rest.length ? rest : DEFAULT_TABS);
        if (activeTabId === id) setActiveTabId((rest[0] ?? DEFAULT_TABS[0]!).id);
      },
      connectCluster,
      disconnectCluster,
      updateCluster: patchCluster,
      hideCluster,
      addCluster,
      deletePod,
      restartDeployment,
      scaleDeployment,
      rollbackDeployment,
      setDeploymentPaused: (id, paused) =>
        patchDeployment(
          id,
          paused
            ? { health: "paused", rollout: "Paused", reason: tt("spec.paused=true") }
            : { health: "healthy", rollout: "Complete", reason: tt("Available, rollout complete") },
        ),
      deleteDeployment: (id) => {
        const d = deployments.find((x) => x.id === id);
        setDeployments((ds) => ds.filter((x) => x.id !== id));
        if (d) toast.show({ kind: "success", title: tt("Deployment deleted"), target: `${d.name} · ${d.cluster}`, env: d.env });
      },
      scenarios,
      setScenario: (key, on) => setScenarios((s) => ({ ...s, [key]: on })),
      simulateSlowList,
      tabs,
      activeTabId,
      activeTab: tabs.find((t) => t.id === activeTabId),
      setActiveTabId,
      openTab,
      openView,
      closeTab: (id) => {
        const closing = tabs.find((t) => t.id === id);
        const index = tabs.findIndex((t) => t.id === id);
        const next = tabs.filter((t) => t.id !== id);
        if (closing) setClosedTabs([...closedTabs, closing].slice(-20));
        setTabs(next);
        if (id === activeTabId) {
          const neighbour = next[Math.min(index, next.length - 1)];
          if (neighbour) setActiveTabId(neighbour.id);
        }
      },
      reopenClosedTab: () => {
        const last = closedTabs[closedTabs.length - 1];
        if (!last) return;
        setClosedTabs(closedTabs.slice(0, -1));
        setTabs([...tabs, last]);
        setActiveTabId(last.id);
      },
      reveal,
      revealResource: (kind, id) => setReveal({ kind, id, seq: Date.now() }),
      backendMeta: desktopState.meta,
      // Desktop mode: every change goes to the Go backend; the mock implementations above stay for browser dev.
      ...desktopState.actions,
    };
  }, [
    desktopState,
    theme,
    themePreference,
    setTheme,
    hideSystemNamespaces,
    density,
    setDensity,
    selectedClusterIds,
    setSelectedClusterIds,
    clusters,
    allPods,
    deployments,
    nodes,
    setNodeCordoned,
    drainNode,
    helmReleases,
    rollbackRelease,
    gitops,
    refreshGitOps,
    syncGitOps,
    setGitOpsSuspended,
    jobs,
    pins,
    setPins,
    investigations,
    setInvestigations,
    current,
    setCurrentInvestigation,
    connectCluster,
    disconnectCluster,
    patchCluster,
    hideCluster,
    addCluster,
    deletePod,
    restartDeployment,
    scaleDeployment,
    rollbackDeployment,
    patchDeployment,
    toast,
    scenarios,
    simulateSlowList,
    tabs,
    closedTabs,
    activeTabId,
    reveal,
  ]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return ctx;
}
