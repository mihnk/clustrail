import { useEffect, useRef, useState } from "react";
import { usePersistentState } from "./preferences";
import { useWorkspace } from "./workspace";

type Policy = "remember" | "all" | "default";

/**
 * A view's namespace filter (null = all namespaces) that starts where
 * Settings › Default namespace filter says whenever a cluster is added to the
 * selection: all namespaces, the clusters' context namespaces, or the
 * namespaces last picked for those clusters.
 */
export function useNamespaceFilter(): [Set<string> | null, (next: Set<string> | null) => void] {
  const { selectedClusterIds, clusterById } = useWorkspace();
  const [policy] = usePersistentState<Policy>("settings.defaultNamespace", "remember");
  const [remembered, setRemembered] = usePersistentState<Record<string, string[]>>("namespaces.remembered", {});
  const [namespaces, setNamespaces] = useState<Set<string> | null>(null);
  const previous = useRef<string[] | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = selectedClusterIds;
    const added = before === null ? selectedClusterIds : selectedClusterIds.filter((id) => !before.includes(id));
    if (!added.length || policy === "all") return;
    if (policy === "default") {
      setNamespaces(new Set(selectedClusterIds.map((id) => clusterById(id)?.namespace || "default")));
      return;
    }
    // Remembered: the union of what was picked per cluster; one cluster with no choice means all.
    const sets = selectedClusterIds.map((id) => remembered[id]);
    setNamespaces(sets.length && sets.every(Boolean) ? new Set(sets.flat() as string[]) : null);
  }, [selectedClusterIds.join(","), policy]);

  const set = (next: Set<string> | null) => {
    setNamespaces(next);
    const memory = { ...remembered };
    for (const id of selectedClusterIds) {
      if (next === null) delete memory[id];
      else memory[id] = [...next];
    }
    setRemembered(memory);
  };
  return [namespaces, set];
}
