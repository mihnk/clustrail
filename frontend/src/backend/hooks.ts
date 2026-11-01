// Data that views read on demand. In desktop mode it comes from the Go
// backend; in a plain browser from the mock layer, so every view works in both.
import { useEffect, useMemo, useState } from "react";
import { backend, onEvent, type DrainPlan } from "./client";
import { getPodDetail } from "@/data/mock";
import type { PodDetail, PodRow, ResourceEvent } from "@/data/types";
import { drainPreflight, type DrainPreflight, type NodeRow } from "@/data/nodes";
import { useWorkspace } from "@/app/workspace";
import { useQuery } from "@/lib/useQuery";

/** Inspector content for a pod. Refetched when the row changes (status, restarts) in desktop mode. */
export function usePodDetail(pod: PodRow | null): PodDetail | null {
  const mock = useMemo(() => (!backend && pod ? getPodDetail(pod) : null), [pod]);
  // The key is the pod's identity and state: refetched when they change, not for every new pod object.
  const key = backend && pod ? `podDetail|${pod.id}|${pod.status}|${pod.restarts}|${pod.readyContainers}` : null;
  const q = useQuery(key, () => backend!.podDetail(pod!.cluster, pod!.namespace, pod!.name), { delay: 120, keepPrevious: true });
  const remote = q.data ?? null;
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
 * pods on the node and their PodDisruptionBudgets; capacity from node rows as
 * they are now. preflight is null while loading or after an error.
 */
export function useDrainPreflight(node: NodeRow): { preflight: DrainPreflight | null; error: string | null; loading: boolean; retry: () => void } {
  const ws = useWorkspace();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mock data: one preflight per node
  const mock = useMemo(() => (backend ? null : drainPreflight(node)), [node.id]);
  const q = useQuery(backend ? `previewDrain|${node.cluster}|${node.name}` : null, () => backend!.previewDrain(node.cluster, node.name, { force: true, deleteEmptyDir: true, timeoutSec: 300 }), { retries: 1 });
  if (!backend) return { preflight: mock, error: null, loading: false, retry: () => {} };
  const plan: DrainPlan | undefined = q.data;
  return { preflight: plan ? preflightOf(plan, node, ws.nodes) : null, error: q.error, loading: q.loading, retry: q.refresh };
}

function preflightOf(plan: DrainPlan, node: NodeRow, nodes: NodeRow[]): DrainPreflight {
  const blocked = new Set(plan.pdbBlocked ?? []);
  const special = new Set([...plan.emptyDir, ...plan.unmanaged, ...blocked]);
  const others = nodes.filter((n) => n.cluster === node.cluster && n.id !== node.id && n.health === "healthy");
  return {
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
  };
}

/** Recent events of an object (desktop), read every 15 s while visible; the mock has none for Deployments and Nodes. */
export function useEvents(cluster: string, namespace: string, kind: string, name: string, active: boolean): ResourceEvent[] | null {
  const q = useQuery(backend && active ? `events|${cluster}|${namespace}|${kind}|${name}` : null, () => backend!.events(cluster, namespace, kind, name), { every: 15_000 });
  if (!backend) return [];
  // A failed read shows what was read before; with nothing before, no events.
  return q.data ?? (q.error ? [] : null);
}

export interface HelmRevisionInfo {
  rev: number;
  manifest: string;
  values: string;
  computed: string;
  hooks: { name: string; kind: string; events: string[] }[];
}

/** One stored Helm revision (desktop). null while loading or in the mock. */
export function useHelmRevision(cluster: string, namespace: string, name: string, rev: number | null): HelmRevisionInfo | { error: string } | null {
  const q = useQuery(backend && rev !== null ? `helmRevision|${cluster}|${namespace}|${name}|${rev}` : null, () => backend!.helmRevision(cluster, namespace, name, rev!));
  if (q.error && !q.data) return { error: q.error };
  return q.data ?? null;
}

/**
 * A value read once and then kept current by a backend event that carries the
 * whole value. Once an event has come, it wins over a read that answers late.
 */
export function useLive<T>(key: string, load: () => Promise<T>, event: string): T | undefined {
  const [pushed, setPushed] = useState<{ value: T } | null>(null);
  const q = useQuery(backend ? key : null, load);
  useEffect(() => (backend ? onEvent<T>(event, (value) => setPushed({ value })) : undefined), [event]);
  return pushed ? pushed.value : q.data;
}
