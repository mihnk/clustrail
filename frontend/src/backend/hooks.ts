// Data that views read on demand. In desktop mode it comes from the Go
// backend; in a plain browser from the mock layer, so every view works in both.
import { useEffect, useMemo, useState } from "react";
import { backend, errorText } from "./client";
import { getPodDetail } from "@/data/mock";
import type { PodDetail, PodRow, ResourceEvent } from "@/data/types";
import { drainPreflight, type DrainPreflight, type NodeRow } from "@/data/nodes";
import { useWorkspace } from "@/app/workspace";
import { everyWhileVisible } from "@/lib/everyWhileVisible";

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

/** Recent events of an object (desktop); the mock has none for Deployments and Nodes. */
export function useEvents(cluster: string, namespace: string, kind: string, name: string, active: boolean): ResourceEvent[] | null {
  const [events, setEvents] = useState<ResourceEvent[] | null>(backend ? null : []);
  useEffect(() => {
    if (!backend || !active) return;
    let cancelled = false;
    const load = () =>
      void backend!
        .events(cluster, namespace, kind, name)
        .then((ev) => !cancelled && setEvents(ev))
        .catch(() => !cancelled && setEvents([]));
    load();
    const stop = everyWhileVisible(load, 15_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [cluster, namespace, kind, name, active]);
  return events;
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
  const [state, setState] = useState<{ key: string; value: HelmRevisionInfo | { error: string } } | null>(null);
  const key = `${cluster}/${namespace}/${name}@${rev}`;
  useEffect(() => {
    if (!backend || rev === null) return;
    let cancelled = false;
    void backend
      .helmRevision(cluster, namespace, name, rev)
      .then((d) => !cancelled && setState({ key, value: d }))
      .catch((e) => !cancelled && setState({ key, value: { error: errorText(e) } }));
    return () => {
      cancelled = true;
    };
  }, [key]);
  return state?.key === key ? state.value : null;
}
