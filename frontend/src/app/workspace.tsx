import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  clusters as initialClusters,
  deployments as initialDeployments,
  initialSelectedClusters,
  pods as initialPods,
} from "@/data/mock";
import type { Cluster, DeploymentRow, PodRow } from "@/data/types";
import { nodes as initialNodes, type NodeRow } from "@/data/nodes";
import { useToast } from "@/components/ui/toast";
import { usePersistentState, type Density, type Theme } from "./preferences";

export type WorkspaceTabKind =
  | "clusters"
  | "pods"
  | "deployments"
  | "nodes"
  | "resource"
  | "investigation"
  | "logs"
  | "shell"
  | "yaml"
  | "compare"
  | "helm"
  | "gitops"
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

/** Explorer kinds have one tab each; tool tabs (Logs, Shell, YAML, Compare) open per target. */
const SINGLETON_KINDS: WorkspaceTabKind[] = ["clusters", "pods", "nodes", "helm", "gitops", "connections", "settings"];

export interface MockScenarios {
  /** prod-us-east-1 loses its watch: rows go stale while it retries. */
  watchLost: boolean;
  /** metrics.k8s.io missing on staging-eu-1. */
  noMetrics: boolean;
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
  kind: "pod" | "deployment" | "node" | "cluster" | "filter";
  id: string;
  seq: number;
}

interface WorkspaceState {
  theme: Theme;
  setTheme: (t: Theme) => void;
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
  jobs: BackgroundJob[];

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
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

const initialTabs: WorkspaceTab[] = [
  { id: "pods", kind: "pods", title: "Pods" },
  { id: "deploy-checkout-api", kind: "resource", title: "checkout-api", subtitle: "Deployment" },
  { id: "inv-checkout-api", kind: "investigation", title: "Investigation · checkout-api" },
  {
    id: "deployments-prod-eu-west-1",
    kind: "deployments",
    title: "Deployments",
    cluster: "prod-eu-west-1",
    params: { namespace: "payments" },
  },
];

const RETRY_SECONDS = 4;

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [theme, setTheme] = usePersistentState<Theme>("theme", "dark");
  const [density, setDensity] = usePersistentState<Density>("density", "default");
  const [selectedClusterIds, setSelectedClusterIds] = usePersistentState<string[]>(
    "selectedClusters",
    initialSelectedClusters,
  );
  const [clusters, setClusters] = useState(initialClusters);
  const [allPods, setAllPods] = useState(initialPods);
  const [deployments, setDeployments] = useState(initialDeployments);
  const [nodes, setNodes] = useState(initialNodes);
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [tabs, setTabs] = useState(initialTabs);
  const [closedTabs, setClosedTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState("pods");
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
          toast.show({ kind: "error", title: "Still unreachable", target: c.name, detail: c.error, copyText: c.error });
          return;
        }
        patchCluster(id, {
          connection: "connected",
          latencyMs: 20 + Math.round(Math.random() * 30),
          summary: c.summary ?? (c.env === "dev" ? "k3s 1.29 · dev.acme.internal" : "GKE 1.31 · europe-west4"),
          authHint: undefined,
          lastConnected: "now",
        });
        toast.show({ kind: "success", title: "Connected", target: c.name, env: c.env });
      });
    },
    [clusters, later, patchCluster, toast],
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
        ps.map((p) => (p.id === id ? { ...p, health: "terminating", status: "Terminating", reason: "Terminating (deleted)" } : p)),
      );
      if (pod) toast.show({ kind: "success", title: "Pod deleted", target: `${pod.name} · ${pod.cluster}`, env: pod.env });
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
              reason: "ContainerCreating",
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
            ? { ...d, health: "progressing", status: "Progressing", rollout: "Progressing", reason: "Rolling out: pod template restartedAt changed", updatedReplicas: 0 }
            : d,
        ),
      );
      const tid = toast.show({
        kind: "progress",
        title: "Restarting rollout",
        target: `${before.name} · ${before.cluster}`,
        env: before.env,
        progress: 0.1,
        detail: `0 of ${before.replicas} pods replaced`,
      });
      later(2000, () =>
        toast.update(tid, { progress: 0.55, detail: `${Math.ceil(before.replicas / 2)} of ${before.replicas} pods replaced` }),
      );
      // The rollout finishes; the Deployment returns to whatever state its pods produce.
      later(4000, () => {
        setDeployments((ds) => ds.map((d) => (d.id === id ? before : d)));
        toast.update(tid, { kind: "success", title: "Rollout restarted", progress: undefined, detail: undefined });
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
      patchDeployment(id, { replicas, rollout: "Progressing", health: "progressing", reason: `Scaling to ${replicas}` });
      later(2500, () => {
        const ready = Math.min(replicas, d.readyReplicas + Math.max(0, replicas - d.replicas));
        patchDeployment(id, {
          replicas,
          readyReplicas: ready,
          availableReplicas: ready,
          updatedReplicas: replicas,
          ...(ready < replicas
            ? { health: "failed" as const, status: "Degraded", rollout: "Degraded", reason: d.reason }
            : { health: "healthy" as const, status: "Available", rollout: "Complete", reason: "Available, rollout complete" }),
        });
        // With an HPA, the controller sets replicas back within its range.
        if (d.hpa && (replicas < d.hpa.min || replicas > d.hpa.max)) {
          later(3000, () => patchDeployment(id, { replicas: d.replicas }));
          toast.show({ kind: "error", title: "Scale overridden by HPA", target: `${d.name} · ${d.cluster}`, detail: `HPA ${d.hpa.name} keeps replicas between ${d.hpa.min} and ${d.hpa.max}.` });
        } else {
          toast.show({ kind: "success", title: `Scaled to ${replicas}`, target: `${d.name} · ${d.cluster}`, env: d.env });
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
        reason: `Rolling back to revision ${rev}`,
        image: target.image,
        updatedReplicas: 0,
        revisions: [{ ...target, rev: next, age: "now" }, ...d.revisions.filter((r) => r.rev !== rev)],
      });
      later(4000, () => patchDeployment(id, { updatedReplicas: d.replicas, rollout: d.readyReplicas < d.replicas ? "Degraded" : "Complete", health: d.health, reason: d.reason }));
      toast.show({ kind: "success", title: `Rolled back to revision ${rev}`, target: `${d.name} · ${d.cluster}`, env: d.env });
    },
    [deployments, later, patchDeployment, toast],
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
                  reason: "Ready, SchedulingDisabled",
                  cordonedBy: "you in Clustrail",
                  cordonedAgo: "now",
                  taints: [...n.taints.filter((t) => t.key !== "node.kubernetes.io/unschedulable"), { key: "node.kubernetes.io/unschedulable", effect: "NoSchedule" }],
                }
              : {
                  ...n,
                  health: n.health === "cordoned" ? "healthy" : n.health,
                  status: n.health === "cordoned" ? "Ready" : n.status,
                  reason: n.health === "cordoned" ? "Ready=True" : n.reason,
                  cordonedBy: undefined,
                  cordonedAgo: undefined,
                  taints: n.taints.filter((t) => t.key !== "node.kubernetes.io/unschedulable"),
                },
        ),
      );
      const n = nodes.find((x) => x.id === id);
      if (n) toast.show({ kind: "success", title: cordoned ? "Node cordoned" : "Node uncordoned", target: `${n.name.split(".")[0]} · ${n.cluster}`, env: n.env });
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
        title: `Draining ${short}`,
        env: n.env,
        progress: 0,
        detail: detail(),
        onCancel: () => {
          cancelled = true;
        },
      });
      setJobs((js) => [...js, { id: jobId, title: `Draining ${short}`, progress: 0, detail: detail() }]);
      const step = setInterval(() => {
        elapsed += 1;
        if (cancelled) {
          clearInterval(step);
          setJobs((js) => js.filter((j) => j.id !== jobId));
          toast.update(tid, { kind: "error", title: `Drain cancelled · ${short}`, progress: undefined, onCancel: undefined, detail: `${evicted} pods evicted. The node stays cordoned.` });
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
              ? { kind: "error", title: `Drain incomplete · ${short}`, progress: undefined, onCancel: undefined, detail: `${blocked} pods still blocked by PodDisruptionBudget checkout-api after the timeout. The node stays cordoned.`, copyText: `kubectl --context ${n.cluster} get pdb -A` }
              : { kind: "success", title: `Drained ${short}`, progress: undefined, onCancel: undefined, detail: `${evicted} pods evicted` },
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
              ? { ...d, updatedReplicas: d.replicas, health: "healthy", status: "Available", rollout: "Complete", reason: "Available, rollout complete" }
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

  const value = useMemo<WorkspaceState>(() => {
    const selected = new Set(selectedClusterIds);
    const clusterById = (id: string) => clusters.find((c) => c.id === id);
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
    return {
      theme,
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
        .filter((p) => selected.has(p.cluster))
        // Without metrics.k8s.io there is no usage: never show 0, show nothing.
        .map((p) => (clusterById(p.cluster)?.metrics === null ? { ...p, cpuMilli: null, memoryMiB: null } : p)),
      allPods,
      deployments,
      nodes,
      setNodeCordoned,
      drainNode,
      jobs,
      connectCluster,
      deletePod,
      restartDeployment,
      scaleDeployment,
      rollbackDeployment,
      setDeploymentPaused: (id, paused) =>
        patchDeployment(
          id,
          paused
            ? { health: "paused", rollout: "Paused", reason: "spec.paused=true" }
            : { health: "healthy", rollout: "Complete", reason: "Available, rollout complete" },
        ),
      deleteDeployment: (id) => {
        const d = deployments.find((x) => x.id === id);
        setDeployments((ds) => ds.filter((x) => x.id !== id));
        if (d) toast.show({ kind: "success", title: "Deployment deleted", target: `${d.name} · ${d.cluster}`, env: d.env });
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
    };
  }, [
    theme,
    setTheme,
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
    jobs,
    connectCluster,
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
