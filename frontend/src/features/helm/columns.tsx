import { createColumnHelper } from "@tanstack/react-table";
import type { HelmRelease } from "@/data/helm";
import { healthRank } from "@/data/health";
import { ResourceStatus } from "@/components/status/ResourceStatus";
import { EnvMarker } from "@/components/status/EnvironmentBadge";
import { formatAge } from "@/lib/format";

const col = createColumnHelper<HelmRelease>();

export const helmColumns = [
  col.accessor((r) => healthRank[r.health], {
    id: "status",
    meta: { label: "Status", width: 118, priority: 100, sortNote: "status · attention first" },
    sortingFn: (a, b) => healthRank[a.original.health] - healthRank[b.original.health] || a.original.name.localeCompare(b.original.name),
    cell: ({ row: { original: r } }) => <ResourceStatus health={r.health} label={r.status} />,
  }),
  col.accessor("name", {
    meta: { label: "Release", width: "fill", priority: 100, sortNote: "release" },
    cell: ({ getValue }) => <span className="block truncate font-medium text-fg">{getValue()}</span>,
  }),
  col.accessor("namespace", {
    meta: { label: "Namespace", width: 92, priority: 70, sortNote: "namespace" },
    cell: ({ getValue }) => <span className="block truncate">{getValue()}</span>,
  }),
  col.accessor("cluster", {
    meta: { label: "Cluster", width: 108, priority: 80, sortNote: "cluster" },
    cell: ({ row: { original: r } }) => (
      <span className="flex min-w-0 items-center gap-1.5">
        <EnvMarker env={r.env} />
        <span className="truncate">{r.cluster}</span>
      </span>
    ),
  }),
  col.accessor((r) => `${r.chart}-${r.chartVersion}`, {
    id: "chart",
    meta: { label: "Chart", width: 150, priority: 60, sortNote: "chart" },
    cell: ({ getValue }) => (
      <span className="block truncate font-mono text-ui" title={getValue()}>
        {getValue()}
      </span>
    ),
  }),
  col.accessor("appVersion", {
    id: "app",
    meta: { label: "App", width: 60, priority: 30, sortNote: "app version" },
    cell: ({ getValue }) => <span className="block truncate font-mono text-ui">{getValue()}</span>,
  }),
  col.accessor("revision", {
    id: "rev",
    meta: { label: "Rev", width: 34, align: "right", priority: 50, sortNote: "revision" },
    cell: ({ getValue }) => <span className="font-mono">{getValue()}</span>,
  }),
  col.accessor("updatedSeconds", {
    id: "updated",
    meta: { label: "Updated", width: 52, align: "right", priority: 40, sortNote: "last update" },
    cell: ({ getValue }) => (getValue() < 5 ? "now" : formatAge(getValue())),
  }),
];
