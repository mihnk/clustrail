// Desktop mode: workspace state comes from the Go backend (snapshot + watch
// deltas) and every mutation is a backend call. The UI follows the resulting
// watch events instead of patching rows itself.
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { backend, errorText, EVENTS, onEvent, type ClusterList, type Delta, type JobEvent } from "@/backend/client";
import { podStream } from "@/backend/podStream";
import type { Cluster, DeploymentRow, PodRow } from "@/data/types";
import type { NodeRow } from "@/data/nodes";
import type { HelmRelease } from "@/data/helm";
import type { GitOpsObject } from "@/data/gitops";
import type { useToast } from "@/components/ui/toast";
import { usePersistentState } from "./preferences";
import type { BackgroundJob, WorkspaceState } from "./workspace";
import { t } from "@/i18n";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Row = { id: string; cluster: string };

/** Applies one watch batch: a reset replaces the cluster's rows, otherwise upserts and deletes by id. */
export function applyDelta<T extends Row>(rows: T[], d: Delta): T[] {
  const upserts = d.upserts as T[];
  if (d.reset) return [...rows.filter((r) => r.cluster !== d.cluster), ...upserts];
  if (upserts.length === 0 && d.deletes.length === 0) return rows;
  const del = new Set(d.deletes);
  const up = new Map(upserts.map((r) => [r.id, r]));
  const out: T[] = [];
  for (const r of rows) {
    if (del.has(r.id)) continue;
    const next = up.get(r.id);
    if (next) up.delete(r.id);
    out.push(next ?? r);
  }
  for (const r of up.values()) out.push(r);
  return out;
}

interface Args {
  toast: ReturnType<typeof useToast>;
  clusters: Cluster[];
  allPods: PodRow[];
  deployments: DeploymentRow[];
  nodes: NodeRow[];
  helmReleases: HelmRelease[];
  gitops: GitOpsObject[];
  setClusters: Setter<Cluster[]>;
  setAllPods: Setter<PodRow[]>;
  setDeployments: Setter<DeploymentRow[]>;
  setNodes: Setter<NodeRow[]>;
  setHelmReleases: Setter<HelmRelease[]>;
  setGitops: Setter<GitOpsObject[]>;
  setJobs: Setter<BackgroundJob[]>;
  selectedClusterIds: string[];
  setSelectedClusterIds: (ids: string[]) => void;
}

type DesktopActions = Pick<
  WorkspaceState,
  | "connectCluster"
  | "disconnectCluster"
  | "updateCluster"
  | "hideCluster"
  | "addCluster"
  | "deletePod"
  | "restartDeployment"
  | "scaleDeployment"
  | "rollbackDeployment"
  | "setDeploymentPaused"
  | "deleteDeployment"
  | "setNodeCordoned"
  | "drainNode"
  | "rollbackRelease"
  | "refreshGitOps"
  | "syncGitOps"
  | "setGitOpsSuspended"
>;

export function useDesktopWorkspace(a: Args): { actions: DesktopActions | null; meta: ClusterList | null } {
  const [meta, setMeta] = useState<ClusterList | null>(null);
  const [autoConnect] = usePersistentState("settings.autoConnect", true);
  const loaded = useRef(false);
  const jobToasts = useRef(new Map<string, number>());
  const { toast } = a;

  // Snapshot, then live events.
  useEffect(() => {
    if (!backend) return;
    const api = backend;
    let cancelled = false;
    const offClusters = onEvent<ClusterList>(EVENTS.clusters, (list) => {
      setMeta(list);
      a.setClusters(list.clusters);
    });
    // Deltas are batched per animation frame so a burst renders once.
    let queue: Delta[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = queue;
      queue = [];
      const by = (k: Delta["kind"]) => batch.filter((d) => d.kind === k);
      const fold = <T extends Row>(set: Setter<T[]>, ds: Delta[]) => ds.length && set((rows) => ds.reduce(applyDelta, rows));
      fold(a.setAllPods, by("pods"));
      fold(a.setDeployments, by("deployments"));
      fold(a.setNodes, by("nodes"));
      fold(a.setHelmReleases, by("helm"));
      fold(a.setGitops, by("gitops"));
    };
    const offDelta = onEvent<Delta>(EVENTS.delta, (d) => {
      queue.push(d);
      if (!frame) frame = requestAnimationFrame(flush);
    });
    const offJob = onEvent<JobEvent>(EVENTS.job, (j) => {
      if (j.done) {
        a.setJobs((js) => js.filter((x) => x.id !== j.id));
        const tid = jobToasts.current.get(j.id);
        if (tid !== undefined) toast.dismiss(tid);
        jobToasts.current.delete(j.id);
        if (j.error) toast.show({ kind: "error", title: `${j.title} failed`, detail: j.error, copyText: j.error });
        else toast.show({ kind: "success", title: j.title.replace(/^(\w+)ing /, (_, v: string) => `${v[0]!.toUpperCase()}${v.slice(1)}ed `), detail: j.detail });
        return;
      }
      a.setJobs((js) => [...js.filter((x) => x.id !== j.id), { id: j.id, title: j.title, progress: j.progress, detail: j.detail }]);
    });
    // Pods come on their own stream (backend/podStream.ts), applied once per animation frame.
    const offPods = podStream.listen(() => a.setAllPods(podStream.rows()));
    const offPodState = podStream.onState((cluster, state, detail) => {
      // Synthetic clusters have no connection of their own: the stream's state is theirs.
      a.setClusters((cs) =>
        cs.map((c) =>
          c.id !== cluster || c.source !== "CLUSTRAIL_SYNTHETIC"
            ? c
            : state === "live"
              ? { ...c, connection: "connected", stale: undefined, error: undefined }
              : state === "connecting"
                ? { ...c, connection: "connecting" }
                : { ...c, connection: "reconnecting", error: detail, stale: c.stale ?? { since: Date.now(), attempt: 1, nextRetrySec: 3 } },
        ),
      );
    });
    void Promise.all([api.clusters(), api.snapshot()])
      .then(([list, snap]) => {
        if (cancelled) return;
        setMeta(list);
        a.setClusters(list.clusters);
        a.setAllPods(snap.pods);
        a.setDeployments(snap.deployments);
        a.setNodes(snap.nodes);
        a.setHelmReleases(snap.helm);
        a.setGitops(snap.gitops);
        const known = new Set(list.clusters.map((c) => c.id));
        a.setSelectedClusterIds((list.selected ?? []).filter((id) => known.has(id)));
        loaded.current = true;
        if (autoConnect) void api.autoConnect();
      })
      .catch((e) => toast.show({ kind: "error", title: t("Backend unavailable"), detail: errorText(e) }));
    return () => {
      cancelled = true;
      offClusters();
      offDelta();
      offPods();
      offPodState();
      offJob();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // The selection is stored by the backend so the next launch connects the same clusters.
  useEffect(() => {
    if (backend && loaded.current) void backend.setSelected(a.selectedClusterIds);
    // Pods are streamed for the selected clusters only: one shared watch each.
    if (backend) podStream.setClusters(a.selectedClusterIds);
  }, [a.selectedClusterIds]);

  const fail = useCallback(
    (title: string, target?: string) => (e: unknown) => toast.show({ kind: "error", title: t(title), target, detail: errorText(e), copyText: errorText(e) }),
    [toast],
  );

  const actions = useMemo<DesktopActions | null>(() => {
    if (!backend) return null;
    const api = backend;
    const pod = (id: string) => a.allPods.find((p) => p.id === id);
    const dep = (id: string) => a.deployments.find((d) => d.id === id);
    const done = (title: string, target: string, env?: Cluster["env"]) => () => toast.show({ kind: "success", title: t(title), target, env });
    return {
      connectCluster: (id) => {
        // Selecting a cluster to connect also adds it to the selection.
        if (!a.selectedClusterIds.includes(id)) a.setSelectedClusterIds([...a.selectedClusterIds, id]);
        api.connect(id).catch(fail("Connect failed", id));
      },
      disconnectCluster: (id) => {
        a.setSelectedClusterIds(a.selectedClusterIds.filter((x) => x !== id));
        api.disconnect(id).catch(fail("Disconnect failed", id));
      },
      updateCluster: (id, patch) => {
        const c = a.clusters.find((x) => x.id === id);
        if (!c) return;
        const next = { ...c, ...patch };
        api.updateCluster(id, next.env, next.protected, next.readOnly).catch(fail("Saving the context settings failed", c.name));
      },
      hideCluster: (id) => {
        a.setSelectedClusterIds(a.selectedClusterIds.filter((x) => x !== id));
        api.hideCluster(id).catch(fail("Hiding the context failed", id));
      },
      addCluster: (c) => {
        a.setSelectedClusterIds([...a.selectedClusterIds, c.id]);
        api.addCluster(c.id, c.env, c.protected, c.readOnly).catch(fail("Adding the context failed", c.name));
      },
      deletePod: (id) => {
        const p = pod(id);
        if (p) api.deletePod(p.cluster, p.namespace, p.name).then(done("Pod deleted", `${p.name} · ${p.cluster}`, p.env), fail("Delete failed", p.name));
      },
      restartDeployment: (id) => {
        const d = dep(id);
        if (d) api.restartDeployment(d.cluster, d.namespace, d.name).then(done("Restart started", `${d.name} · ${d.cluster}`, d.env), fail("Restart failed", d.name));
      },
      scaleDeployment: (id, replicas) => {
        const d = dep(id);
        if (d) api.scaleDeployment(d.cluster, d.namespace, d.name, replicas).then(done(`Scaled to ${replicas}`, `${d.name} · ${d.cluster}`, d.env), fail("Scale failed", d.name));
      },
      rollbackDeployment: (id, rev) => {
        const d = dep(id);
        if (d) api.rollbackDeployment(d.cluster, d.namespace, d.name, rev).then(done(`Rolled back to revision ${rev}`, `${d.name} · ${d.cluster}`, d.env), fail("Rollback failed", d.name));
      },
      setDeploymentPaused: (id, paused) => {
        const d = dep(id);
        if (d) api.setDeploymentPaused(d.cluster, d.namespace, d.name, paused).then(done(paused ? "Rollout paused" : "Rollout resumed", `${d.name} · ${d.cluster}`, d.env), fail("Update failed", d.name));
      },
      deleteDeployment: (id) => {
        const d = dep(id);
        if (d) api.deleteDeployment(d.cluster, d.namespace, d.name).then(done("Deployment deleted", `${d.name} · ${d.cluster}`, d.env), fail("Delete failed", d.name));
      },
      setNodeCordoned: (id, cordoned) => {
        const n = a.nodes.find((x) => x.id === id);
        if (n) api.setNodeCordoned(n.cluster, n.name, cordoned).then(done(cordoned ? "Node cordoned" : "Node uncordoned", `${n.name.split(".")[0]} · ${n.cluster}`, n.env), fail("Cordon failed", n.name));
      },
      drainNode: (id, opts) => {
        const n = a.nodes.find((x) => x.id === id);
        if (n) api.drainNode(n.cluster, n.name, opts).catch(fail("Drain refused", n.name));
      },
      rollbackRelease: (id, rev) => {
        const r = a.helmReleases.find((x) => x.id === id);
        if (r) api.rollbackRelease(r.cluster, r.namespace, r.name, rev).catch(fail("Rollback failed", r.name));
      },
      refreshGitOps: (id) => {
        const o = a.gitops.find((x) => x.id === id);
        if (o) api.refreshGitOps(o.cluster, o.kind, o.namespace, o.name).then(done(o.tool === "Argo CD" ? "Refresh requested" : "Reconcile requested", `${o.name} · ${o.cluster}`, o.env), fail("Refresh failed", o.name));
      },
      syncGitOps: (id) => {
        const o = a.gitops.find((x) => x.id === id);
        if (o) api.syncGitOps(o.cluster, o.kind, o.namespace, o.name).then(done(o.tool === "Argo CD" ? "Sync started" : "Reconcile requested", `${o.name} · ${o.cluster}`, o.env), fail("Sync failed", o.name));
      },
      setGitOpsSuspended: (id, suspended) => {
        const o = a.gitops.find((x) => x.id === id);
        if (o) api.setGitOpsSuspended(o.cluster, o.kind, o.namespace, o.name, suspended).then(done(suspended ? "Suspended" : "Resumed", `${o.name} · ${o.cluster}`, o.env), fail("Update failed", o.name));
      },
    };
  }, [a.allPods, a.deployments, a.nodes, a.helmReleases, a.gitops, a.clusters, a.selectedClusterIds, toast, fail]);

  return { actions, meta };
}
