import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { clusters as allClusters, initialSelectedClusters, pods as allPods } from "@/data/mock";
import type { Cluster, PodRow } from "@/data/types";
import { usePersistentState, type Density, type Theme } from "./preferences";

export type WorkspaceTabKind = "pods" | "resource" | "investigation";

export interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  title: string;
  subtitle?: string;
}

interface WorkspaceState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  density: Density;
  setDensity: (d: Density) => void;

  clusters: Cluster[];
  selectedClusterIds: string[];
  toggleCluster: (id: string, selected: boolean) => void;
  selectedClusters: Cluster[];
  /** Pods from the selected clusters. Filtering by view happens per tab. */
  pods: PodRow[];

  tabs: WorkspaceTab[];
  activeTabId: string;
  setActiveTabId: (id: string) => void;
  closeTab: (id: string) => void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

const initialTabs: WorkspaceTab[] = [
  { id: "pods", kind: "pods", title: "Pods" },
  { id: "deploy-checkout-api", kind: "resource", title: "checkout-api", subtitle: "Deployment" },
  { id: "inv-checkout-api", kind: "investigation", title: "Investigation · checkout-api" },
];

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = usePersistentState<Theme>("theme", "dark");
  const [density, setDensity] = usePersistentState<Density>("density", "default");
  const [selectedClusterIds, setSelectedClusterIds] = usePersistentState<string[]>(
    "selectedClusters",
    initialSelectedClusters,
  );
  const [tabs, setTabs] = useState(initialTabs);
  const [activeTabId, setActiveTabId] = useState("pods");

  const value = useMemo<WorkspaceState>(() => {
    const selected = new Set(selectedClusterIds);
    return {
      theme,
      setTheme,
      density,
      setDensity,
      clusters: allClusters,
      selectedClusterIds,
      toggleCluster: (id, on) =>
        setSelectedClusterIds(on ? [...selectedClusterIds, id] : selectedClusterIds.filter((c) => c !== id)),
      selectedClusters: allClusters.filter((c) => selected.has(c.id)),
      pods: allPods.filter((p) => selected.has(p.cluster)),
      tabs,
      activeTabId,
      setActiveTabId,
      closeTab: (id) => {
        const next = tabs.filter((t) => t.id !== id);
        setTabs(next);
        if (id === activeTabId && next[0]) setActiveTabId(next[0].id);
      },
    };
  }, [theme, setTheme, density, setDensity, selectedClusterIds, setSelectedClusterIds, tabs, activeTabId]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return ctx;
}
