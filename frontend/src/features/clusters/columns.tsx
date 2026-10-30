import { createColumnHelper } from "@tanstack/react-table";
import { KeyRound, Lock, RefreshCw } from "lucide-react";
import type { Cluster, Health } from "@/data/types";
import type { ClusterOverview } from "@/data/clusterOverview";
import { Button } from "@/components/ui/button";
import { Meter } from "@/components/ui/meter";
import { EnvMarker, connectionLabel } from "@/components/status/EnvironmentBadge";
import { CountPill } from "@/components/status/ResourceStatus";
import { StatusGlyph, healthTone } from "@/components/status/StatusGlyph";
import { isOffline } from "@/components/cluster/ClusterStates";
import { cn } from "@/lib/cn";

export interface ClusterRow {
  id: string;
  cluster: Cluster;
  ov: ClusterOverview;
  pods: number;
  podsAttention: number;
}

const connectionHealth: Record<Cluster["connection"], Health> = {
  connected: "healthy",
  connecting: "progressing",
  reconnecting: "warning",
  disconnected: "unknown",
  "auth-expired": "warning",
  unreachable: "failed",
};

const col = createColumnHelper<ClusterRow>();
const dash = <span className="text-fg-muted">—</span>;

export function clusterColumns(onFix: (c: Cluster) => void) {
  return [
    col.accessor((r) => r.cluster.name, {
      id: "cluster",
      meta: { label: "Cluster", width: "fill", priority: 100, sortNote: "name" },
      cell: ({ row: { original: r } }) => (
        <div className="flex min-w-0 flex-col gap-[3px]">
          <span className="flex min-w-0 items-center gap-2">
            <EnvMarker env={r.cluster.env} />
            <span className={cn("truncate font-mono text-ui text-fg", !isOffline(r.cluster) && "font-semibold")}>{r.cluster.name}</span>
            {r.cluster.protected && <Lock className="size-3.5 shrink-0 text-env-prod-ink" aria-label="Protected" />}
          </span>
          <span className="truncate text-meta text-fg-muted">
            {r.ov.provider} · {r.ov.region} · {r.ov.contextHint}
          </span>
        </div>
      ),
    }),
    col.accessor((r) => r.cluster.connection, {
      id: "status",
      meta: { label: "Status · API", width: 132, priority: 100, sortNote: "status" },
      cell: ({ row: { original: r } }) => {
        const c = r.cluster;
        const h = connectionHealth[c.connection];
        return (
          <div className="flex min-w-0 flex-col gap-[3px]">
            <span className={cn("flex items-center gap-[7px] text-ui font-medium", healthTone[h])}>
              <StatusGlyph health={h} />
              <span className="truncate">{connectionLabel[c.connection]}</span>
              {c.latencyMs !== null && c.connection === "connected" && (
                <span className={cn("font-mono font-normal", c.latencyMs > 100 ? "text-status-warning" : "text-fg-muted")}>
                  {c.latencyMs}ms
                </span>
              )}
            </span>
            <span
              className={cn("truncate text-meta", r.ov.problems && c.connection === "connected" ? "text-status-critical" : "text-fg-muted")}
              title={c.error}
            >
              {c.connection === "auth-expired"
                ? c.authHint?.plugin
                : c.connection === "unreachable"
                  ? c.error?.split(": ").pop()
                  : c.connection === "disconnected"
                    ? `last connected ${c.lastConnected ?? "never"}`
                    : (r.ov.problems ?? "No problems reported")}
            </span>
          </div>
        );
      },
    }),
    col.accessor((r) => r.ov.version, {
      id: "version",
      meta: { label: "Version", width: 62, priority: 50, sortNote: "version" },
      cell: ({ row: { original: r } }) => (isOffline(r.cluster) ? dash : <span className="font-mono text-ui">{r.ov.version}</span>),
    }),
    col.accessor((r) => r.ov.nodes.total, {
      id: "nodes",
      meta: { label: "Nodes", width: 56, align: "right", priority: 60, sortNote: "nodes" },
      cell: ({ row: { original: r } }) =>
        isOffline(r.cluster) ? (
          dash
        ) : (
          <span className={cn(r.ov.nodes.ready < r.ov.nodes.total && "text-status-warning")}>
            {r.ov.nodes.ready}/{r.ov.nodes.total}
          </span>
        ),
    }),
    col.accessor((r) => r.pods, {
      id: "pods",
      meta: { label: "Pods", width: 84, align: "right", priority: 70, sortNote: "pods" },
      cell: ({ row: { original: r } }) =>
        isOffline(r.cluster) ? (
          dash
        ) : (
          <span className="flex items-center justify-end gap-1.5">
            {r.pods}
            {r.podsAttention > 0 && <CountPill tone="critical">{r.podsAttention}</CountPill>}
          </span>
        ),
    }),
    col.accessor((r) => (r.ov.cpu.used ?? -1) / Math.max(r.ov.cpu.allocatable, 1e-9), {
      id: "cpu",
      meta: { label: "CPU used", width: 96, priority: 80, sortNote: "CPU usage" },
      sortDescFirst: true,
      cell: ({ row: { original: r } }) =>
        isOffline(r.cluster) ? (
          <Button
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onFix(r.cluster);
            }}
          >
            {r.cluster.connection === "auth-expired" ? <KeyRound aria-hidden /> : <RefreshCw aria-hidden />}
            {r.cluster.connection === "auth-expired" ? "Re-authenticate" : r.cluster.connection === "unreachable" ? "Retry" : "Connect"}
          </Button>
        ) : (
          <Usage used={r.cluster.metrics ? r.ov.cpu.used : null} total={r.ov.cpu.allocatable} unit="cores" label="CPU used" />
        ),
    }),
    col.accessor((r) => (r.ov.memoryGiB.used ?? -1) / Math.max(r.ov.memoryGiB.allocatable, 1e-9), {
      id: "memory",
      meta: { label: "Memory used", width: 96, priority: 80, sortNote: "memory usage" },
      sortDescFirst: true,
      cell: ({ row: { original: r } }) =>
        isOffline(r.cluster) ? null : (
          <Usage used={r.cluster.metrics ? r.ov.memoryGiB.used : null} total={r.ov.memoryGiB.allocatable} unit="GiB" label="Memory used" />
        ),
    }),
  ];
}

function Usage({ used, total, unit, label }: { used: number | null; total: number; unit: string; label: string }) {
  if (used === null) {
    return (
      <span className="text-fg-muted" title="No usage data: metrics.k8s.io is not available">
        —
      </span>
    );
  }
  const pct = used / total;
  return (
    <div className="flex min-w-0 flex-col gap-[3px]">
      <span className="flex items-center gap-1.5">
        <Meter value={pct} label={`${label} ${Math.round(pct * 100)}%`} />
        <span className={cn("min-w-[30px] text-right font-mono text-ui tabular-nums", pct >= 0.8 && "text-status-warning")}>
          {Math.round(pct * 100)}%
        </span>
      </span>
      <span className="truncate font-mono text-meta text-fg-muted">
        {used} / {total} {unit}
      </span>
    </div>
  );
}
