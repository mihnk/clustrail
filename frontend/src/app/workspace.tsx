import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import {
  clusters as allClusters,
  deployments as initialDeployments,
  initialSelectedClusters,
  pods as initialPods,
} from "@/data/mock";
import type { Cluster, DeploymentRow, PodRow } from "@/data/types";
import { usePersistentState, type Density, type Theme } from "./preferences";

export type WorkspaceTabKind = "pods" | "deployments" | "resource" | "investigation";

export interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  title: string;
  subtitle?: string;
  /** Tabs scoped to one cluster show its environment and protection. */
  cluster?: string;
}

interface WorkspaceState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  density: Density;
  setDensity: (d: Density) => void;

  clusters: Cluster[];
  clusterById: (id: string) => Cluster | undefined;
  selectedClusterIds: string[];
  toggleCluster: (id: string, selected: boolean) => void;
  selectedClusters: Cluster[];
  /** Pods from the selected clusters. Filtering by view happens per tab. */
  pods: PodRow[];
  deployments: DeploymentRow[];

  // Mock mutations. In the desktop build these are requests to the Go backend;
  // the UI then follows the resulting watch events.
  deletePod: (id: string) => void;
  restartDeployment: (id: string) => void;

  tabs: WorkspaceTab[];
  activeTabId: string;
  activeTab: WorkspaceTab | undefined;
  setActiveTabId: (id: string) => void;
  /** Activates the tab if it exists; returns whether it did. */
  openTab: (id: string) => boolean;
  closeTab: (id: string) => void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

const initialTabs: WorkspaceTab[] = [
  { id: "pods", kind: "pods", title: "Pods" },
  { id: "deploy-checkout-api", kind: "resource", title: "checkout-api", subtitle: "Deployment" },
  { id: "inv-checkout-api", kind: "investigation", title: "Investigation · checkout-api" },
  { id: "deployments-prod-eu-west-1", kind: "deployments", title: "Deployments", cluster: "prod-eu-west-1" },
];

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = usePersistentState<Theme>("theme", "dark");
  const [density, setDensity] = usePersistentState<Density>("density", "default");
  const [selectedClusterIds, setSelectedClusterIds] = usePersistentState<string[]>(
    "selectedClusters",
    initialSelectedClusters,
  );
  const [allPods, setAllPods] = useState(initialPods);
  const [deployments, setDeployments] = useState(initialDeployments);
  const [tabs, setTabs] = useState(initialTabs);
  const [activeTabId, setActiveTabId] = useState("pods");
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const later = useCallback((ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, ms);
    timers.current.add(t);
  }, []);

  const deletePod = useCallback(
    (id: string) => {
      setAllPods((ps) =>
        ps.map((p) => (p.id === id ? { ...p, health: "terminating", status: "Terminating", reason: "Terminating (deleted)" } : p)),
      );
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
    [later],
  );

  const restartDeployment = useCallback(
    (id: string) => {
      const before = deployments.find((d) => d.id === id);
      if (!before) return;
      setDeployments((ds) =>
        ds.map((d) => (d.id === id ? { ...d, health: "progressing", status: "Progressing", updatedReplicas: 0 } : d)),
      );
      // The rollout finishes; the Deployment returns to whatever state its pods produce.
      later(4000, () => setDeployments((ds) => ds.map((d) => (d.id === id ? before : d))));
    },
    [deployments, later],
  );

  const value = useMemo<WorkspaceState>(() => {
    const selected = new Set(selectedClusterIds);
    const clusterById = (id: string) => allClusters.find((c) => c.id === id);
    const openTab = (id: string) => {
      if (!tabs.some((t) => t.id === id)) return false;
      setActiveTabId(id);
      return true;
    };
    return {
      theme,
      setTheme,
      density,
      setDensity,
      clusters: allClusters,
      clusterById,
      selectedClusterIds,
      toggleCluster: (id, on) =>
        setSelectedClusterIds(on ? [...selectedClusterIds, id] : selectedClusterIds.filter((c) => c !== id)),
      selectedClusters: allClusters.filter((c) => selected.has(c.id)),
      pods: allPods.filter((p) => selected.has(p.cluster)),
      deployments,
      deletePod,
      restartDeployment,
      tabs,
      activeTabId,
      activeTab: tabs.find((t) => t.id === activeTabId),
      setActiveTabId,
      openTab,
      closeTab: (id) => {
        const next = tabs.filter((t) => t.id !== id);
        setTabs(next);
        if (id === activeTabId && next[0]) setActiveTabId(next[0].id);
      },
    };
  }, [
    theme,
    setTheme,
    density,
    setDensity,
    selectedClusterIds,
    setSelectedClusterIds,
    allPods,
    deployments,
    deletePod,
    restartDeployment,
    tabs,
    activeTabId,
  ]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return ctx;
}
