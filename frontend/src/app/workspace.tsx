import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  clusters as initialClusters,
  deployments as initialDeployments,
  initialSelectedClusters,
  pods as initialPods,
} from "@/data/mock";
import type { Cluster, DeploymentRow, PodRow } from "@/data/types";
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

  /** Connect, retry or re-authenticate a cluster (mock: simulated outcome). */
  connectCluster: (id: string) => void;

  // Mock mutations. In the desktop build these are requests to the Go backend;
  // the UI then follows the resulting watch events.
  deletePod: (id: string) => void;
  restartDeployment: (id: string) => void;

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
        ds.map((d) => (d.id === id ? { ...d, health: "progressing", status: "Progressing", updatedReplicas: 0 } : d)),
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
      connectCluster,
      deletePod,
      restartDeployment,
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
    connectCluster,
    deletePod,
    restartDeployment,
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
