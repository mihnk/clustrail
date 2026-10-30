import { createColumnHelper } from "@tanstack/react-table";
import type { PodRow } from "@/data/types";
import { healthRank, isAttention } from "@/data/health";
import { ResourceStatus } from "@/components/status/ResourceStatus";
import { EnvMarker } from "@/components/status/EnvironmentBadge";
import { formatAge, formatCpu, formatMemory } from "@/lib/format";
import { cn } from "@/lib/cn";

const col = createColumnHelper<PodRow>();

export const podColumns = [
  col.accessor((p) => healthRank[p.health], {
    id: "status",
    meta: { label: "Status", width: 104, priority: 100, sortNote: "status · attention first" },
    // Attention first; among pods needing attention the one restarting most
    // leads, everything else keeps a stable name order.
    sortingFn: (a, b) => {
      const pa = a.original;
      const pb = b.original;
      const rank = healthRank[pa.health] - healthRank[pb.health];
      if (rank !== 0) return rank;
      if (isAttention(pa.health) && pb.restarts !== pa.restarts) return pb.restarts - pa.restarts;
      return pa.name.localeCompare(pb.name);
    },
    cell: ({ row: { original: p } }) => <ResourceStatus health={p.health} label={p.status} title={p.reason} />,
  }),
  col.accessor("name", {
    meta: { label: "Name", width: "fill", priority: 100, sortNote: "name" },
    cell: ({ getValue }) => (
      <span className="block truncate font-mono text-ui text-fg" title={getValue()}>
        {getValue()}
      </span>
    ),
  }),
  col.accessor("namespace", {
    meta: { label: "Namespace", width: 84, priority: 70, sortNote: "namespace" },
    cell: ({ getValue }) => <span className="block truncate">{getValue()}</span>,
  }),
  col.accessor("cluster", {
    meta: { label: "Cluster", width: 112, priority: 80, sortNote: "cluster" },
    cell: ({ row: { original: p } }) => (
      <span className="flex min-w-0 items-center gap-1.5">
        <EnvMarker env={p.env} />
        <span className="truncate">{p.cluster}</span>
        {p.staleSeconds !== undefined && (
          <span className="rounded bg-surface-hover px-[5px] py-[3px] font-mono text-2xs font-medium leading-none text-fg-secondary">
            {p.staleSeconds}s
          </span>
        )}
      </span>
    ),
  }),
  col.accessor("node", {
    meta: { label: "Node", width: 112, priority: 30, sortNote: "node" },
    // Short host name; the full node name is in the tooltip and the inspector.
    cell: ({ getValue }) => (
      <span className="block truncate font-mono text-meta" title={getValue()}>
        {getValue().split(".")[0]}
      </span>
    ),
  }),
  col.accessor((p) => p.readyContainers / Math.max(1, p.totalContainers), {
    id: "ready",
    meta: { label: "Ready", width: 40, align: "right", priority: 90, sortNote: "readiness" },
    cell: ({ row: { original: p } }) => {
      const notReady = p.health !== "completed" && p.readyContainers < p.totalContainers;
      return (
        <span className={cn(notReady && "text-status-warning")}>
          {p.readyContainers}/{p.totalContainers}
        </span>
      );
    },
  }),
  col.accessor("restarts", {
    meta: { label: "Restarts", width: 52, align: "right", priority: 85, sortNote: "restarts" },
    sortDescFirst: true,
    cell: ({ getValue }) => {
      const n = getValue();
      return (
        <span className={n >= 5 ? "text-status-critical" : n > 0 ? "text-status-warning" : "text-fg-muted"}>{n}</span>
      );
    },
  }),
  col.accessor((p) => p.cpuMilli ?? -1, {
    id: "cpu",
    meta: { label: "CPU", width: 48, align: "right", priority: 60, sortNote: "CPU" },
    sortDescFirst: true,
    cell: ({ row: { original: p } }) => <span title={p.cpuMilli === null ? "No usage data" : undefined}>{formatCpu(p.cpuMilli)}</span>,
  }),
  col.accessor((p) => p.memoryMiB ?? -1, {
    id: "memory",
    meta: { label: "Memory", width: 54, align: "right", priority: 60, sortNote: "memory" },
    sortDescFirst: true,
    cell: ({ row: { original: p } }) => <span title={p.memoryMiB === null ? "No usage data" : undefined}>{formatMemory(p.memoryMiB)}</span>,
  }),
  col.accessor("ageSeconds", {
    id: "age",
    meta: { label: "Age", width: 36, align: "right", priority: 50, sortNote: "age" },
    cell: ({ getValue }) => formatAge(getValue()),
  }),
];
