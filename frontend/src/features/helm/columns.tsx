import { createColumnHelper } from "@tanstack/react-table";
import type { HelmRelease } from "@/data/helm";
import { healthRank } from "@/data/health";
import { ResourceStatus } from "@/components/status/ResourceStatus";
import { EnvMarker } from "@/components/status/EnvironmentBadge";
import { formatAge } from "@/lib/format";
import { t } from "@/i18n";

const col = createColumnHelper<HelmRelease>();

export const helmColumns = [
  col.accessor((r) => healthRank[r.health], {
    id: "status",
    meta: { label: t("Status"), width: 118, priority: 100, sortNote: t("status · attention first") },
    sortingFn: (a, b) => healthRank[a.original.health] - healthRank[b.original.health] || a.original.name.localeCompare(b.original.name),
    cell: ({ row: { original: r } }) => <ResourceStatus health={r.health} label={r.status} />,
  }),
  col.accessor("name", {
    meta: { label: t("Release"), width: "fill", priority: 100, sortNote: t("release") },
    cell: ({ getValue }) => <span className="block truncate font-medium text-fg">{getValue()}</span>,
  }),
  col.accessor("namespace", {
    meta: { label: t("Namespace"), width: 92, priority: 70, sortNote: t("namespace") },
    cell: ({ getValue }) => <span className="block truncate">{getValue()}</span>,
  }),
  col.accessor("cluster", {
    meta: { label: t("Cluster"), width: 108, priority: 80, sortNote: t("cluster") },
    cell: ({ row: { original: r } }) => (
      <span className="flex min-w-0 items-center gap-1.5">
        <EnvMarker env={r.env} />
        <span className="truncate">{r.cluster}</span>
      </span>
    ),
  }),
  col.accessor((r) => `${r.chart}-${r.chartVersion}`, {
    id: "chart",
    meta: { label: t("Chart"), width: 150, priority: 60, sortNote: t("chart") },
    cell: ({ getValue }) => (
      <span className="block truncate font-mono text-ui" title={getValue()}>
        {getValue()}
      </span>
    ),
  }),
  col.accessor("appVersion", {
    id: "app",
    meta: { label: t("App"), width: 60, priority: 30, sortNote: t("app version") },
    cell: ({ getValue }) => <span className="block truncate font-mono text-ui">{getValue()}</span>,
  }),
  col.accessor("revision", {
    id: "rev",
    meta: { label: t("Rev"), width: 34, align: "right", priority: 50, sortNote: t("revision") },
    cell: ({ getValue }) => <span className="font-mono">{getValue()}</span>,
  }),
  col.accessor("updatedSeconds", {
    id: "updated",
    meta: { label: t("Updated"), width: 52, align: "right", priority: 40, sortNote: t("last update") },
    cell: ({ getValue }) => (getValue() < 5 ? "now" : formatAge(getValue())),
  }),
];
