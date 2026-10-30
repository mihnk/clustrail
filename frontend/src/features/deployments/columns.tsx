import { createColumnHelper } from "@tanstack/react-table";
import type { DeploymentRow } from "@/data/types";
import { healthRank } from "@/data/health";
import { ResourceStatus } from "@/components/status/ResourceStatus";
import { EnvMarker } from "@/components/status/EnvironmentBadge";
import { formatAge } from "@/lib/format";
import { cn } from "@/lib/cn";

const col = createColumnHelper<DeploymentRow>();

export function strategyLabel(s: DeploymentRow["strategy"]): string {
  return s.type === "Recreate" ? "Recreate" : `Rolling ${s.maxSurge}/${s.maxUnavailable}`;
}

/** Single-cluster list (protected production view). */
export const deploymentColumns = [
  col.accessor((d) => healthRank[d.health], {
    id: "status",
    meta: { label: "Status", width: 110, priority: 100, sortNote: "status · attention first" },
    sortingFn: (a, b) =>
      healthRank[a.original.health] - healthRank[b.original.health] || a.original.name.localeCompare(b.original.name),
    cell: ({ row: { original: d } }) => <ResourceStatus health={d.health} label={d.status} />,
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
    meta: { label: "Namespace", width: 110, priority: 60, sortNote: "namespace" },
    cell: ({ getValue }) => <span className="block truncate">{getValue()}</span>,
  }),
  col.accessor((d) => d.readyReplicas / Math.max(1, d.replicas), {
    id: "ready",
    meta: { label: "Ready", width: 70, align: "right", priority: 90, sortNote: "readiness" },
    cell: ({ row: { original: d } }) => (
      <span className={cn(d.readyReplicas < d.replicas && "text-status-warning")}>
        {d.readyReplicas}/{d.replicas}
      </span>
    ),
  }),
  col.accessor("updatedReplicas", {
    id: "upToDate",
    meta: { label: "Up-to-date", width: 90, align: "right", priority: 70, sortNote: "up-to-date replicas" },
  }),
  col.accessor("availableReplicas", {
    id: "available",
    meta: { label: "Available", width: 90, align: "right", priority: 80, sortNote: "available replicas" },
  }),
  col.accessor((d) => strategyLabel(d.strategy), {
    id: "strategy",
    meta: { label: "Strategy", width: 140, priority: 50, sortNote: "strategy" },
    cell: ({ getValue }) => <span className="font-mono text-meta">{getValue()}</span>,
  }),
  col.accessor("ageSeconds", {
    id: "age",
    meta: { label: "Age", width: 60, align: "right", priority: 40, sortNote: "age" },
    cell: ({ getValue }) => formatAge(getValue()),
  }),
];

/** Multi-cluster explorer: rollout state first, image tag instead of strategy. */
export const deploymentExplorerColumns = [
  col.accessor((d) => healthRank[d.health], {
    id: "rollout",
    meta: { label: "Rollout", width: 100, priority: 100, sortNote: "rollout · attention first" },
    sortingFn: (a, b) =>
      healthRank[a.original.health] - healthRank[b.original.health] || a.original.name.localeCompare(b.original.name),
    cell: ({ row: { original: d } }) => <ResourceStatus health={d.health} label={d.rollout} title={d.reason} />,
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
    meta: { label: "Namespace", width: 80, priority: 70, sortNote: "namespace" },
    cell: ({ getValue }) => <span className="block truncate">{getValue()}</span>,
  }),
  col.accessor("cluster", {
    meta: { label: "Cluster", width: 108, priority: 80, sortNote: "cluster" },
    cell: ({ row: { original: d } }) => (
      <span className="flex min-w-0 items-center gap-1.5">
        <EnvMarker env={d.env} />
        <span className="truncate">{d.cluster}</span>
      </span>
    ),
  }),
  col.accessor((d) => d.readyReplicas / Math.max(1, d.replicas), {
    id: "ready",
    meta: { label: "Ready", width: 44, align: "right", priority: 90, sortNote: "readiness" },
    cell: ({ row: { original: d } }) => (
      <span className={cn(d.readyReplicas < d.replicas && "text-status-warning")}>
        {d.readyReplicas}/{d.replicas}
      </span>
    ),
  }),
  col.accessor("updatedReplicas", {
    id: "upToDate",
    meta: { label: "Upd", width: 34, align: "right", priority: 60, sortNote: "up-to-date replicas" },
  }),
  col.accessor("availableReplicas", {
    id: "available",
    meta: { label: "Avail", width: 38, align: "right", priority: 65, sortNote: "available replicas" },
  }),
  col.accessor("image", {
    meta: { label: "Image tag", width: 92, priority: 40, sortNote: "image tag" },
    cell: ({ getValue }) => (
      <span className="block truncate font-mono text-meta" title={getValue()}>
        {getValue()}
      </span>
    ),
  }),
  col.accessor("ageSeconds", {
    id: "age",
    meta: { label: "Age", width: 36, align: "right", priority: 45, sortNote: "age" },
    cell: ({ getValue }) => formatAge(getValue()),
  }),
];
