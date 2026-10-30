// Data that views read on demand. In desktop mode it comes from the Go
// backend; in a plain browser from the mock layer, so every view works in both.
import { useEffect, useMemo, useState } from "react";
import { backend } from "./client";
import { getPodDetail } from "@/data/mock";
import type { PodDetail, PodRow } from "@/data/types";
import { drainPreflight, type DrainPreflight, type NodeRow } from "@/data/nodes";
import { useWorkspace } from "@/app/workspace";

/** Inspector content for a pod. Refetched when the row changes (status, restarts) in desktop mode. */
export function usePodDetail(pod: PodRow | null): PodDetail | null {
  const mock = useMemo(() => (!backend && pod ? getPodDetail(pod) : null), [pod]);
  const [remote, setRemote] = useState<PodDetail | null>(null);
  const key = pod ? `${pod.id}|${pod.status}|${pod.restarts}|${pod.readyContainers}` : "";
  useEffect(() => {
    if (!backend || !pod) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void backend!
        .podDetail(pod.cluster, pod.namespace, pod.name)
        .then((d) => !cancelled && setRemote(d))
        .catch(() => !cancelled && setRemote(null));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key]);
  if (!backend) return mock;
  if (!pod) return null;
  // Until the backend answers, show what the row already knows.
  if (!remote || remote.pod.id !== pod.id) {
    return { pod, problem: null, containers: [], events: [], memory: null, ownerChain: [], relations: [] };
  }
  return { ...remote, pod };
}


const stripHash = (pod: string) => pod.split("/").pop()!.replace(/-[a-z0-9]{5}$/, "");

/**
 * What a drain would do to each pod. Desktop: computed by the backend from the
 * pods on the node and their PodDisruptionBudgets; capacity from node rows.
 * null while loading.
 */
export function useDrainPreflight(node: NodeRow): DrainPreflight | null {
  const ws = useWorkspace();
  const mock = useMemo(() => (backend ? null : drainPreflight(node)), [node.id]);
  const [remote, setRemote] = useState<DrainPreflight | null>(null);
  useEffect(() => {
    if (!backend) return;
    let cancelled = false;
    void backend.previewDrain(node.cluster, node.name, { force: true, deleteEmptyDir: true, timeoutSec: 300 }).then((plan) => {
      if (cancelled) return;
      const blocked = new Set(plan.pdbBlocked ?? []);
      const special = new Set([...plan.emptyDir, ...plan.unmanaged, ...blocked]);
      const others = ws.nodes.filter((n) => n.cluster === node.cluster && n.id !== node.id && n.health === "healthy");
      setRemote({
        evict: plan.evict.filter((k) => !special.has(k)).length,
        pdbBlocked: { pods: [...blocked], pdb: plan.pdb ?? "" },
        emptyDir: plan.emptyDir.map((pod) => ({ pod, size: "size unknown" })),
        unmanaged: plan.unmanaged,
        daemonSets: [...new Set(plan.daemonSet.map(stripHash))],
        freeAfter: {
          cpu: Math.round(others.reduce((a, n) => a + n.cpu.allocatable - n.cpu.requests, 0) * 10) / 10,
          memGiB: Math.round(others.reduce((a, n) => a + n.memoryGiB.allocatable - n.memoryGiB.requests, 0)),
          nodes: others.length,
        },
        evictedRequests: { cpu: node.cpu.requests, memGiB: node.memoryGiB.requests },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [node.id]);
  return backend ? remote : mock;
}
