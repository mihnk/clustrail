import { createColumnHelper } from "@tanstack/react-table";
import type { DeploymentRow } from "@/data/types";
import { healthRank } from "@/data/health";
import { ResourceStatus } from "@/components/status/ResourceStatus";
import { formatAge } from "@/lib/format";
import { cn } from "@/lib/cn";

const col = createColumnHelper<DeploymentRow>();

export function strategyLabel(s: DeploymentRow["strategy"]): string {
  return s.type === "Recreate" ? "Recreate" : `Rolling ${s.maxSurge}/${s.maxUnavailable}`;
}

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
