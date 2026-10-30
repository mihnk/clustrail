import { createColumnHelper } from "@tanstack/react-table";
import type { NodeRow } from "@/data/nodes";
import { healthRank } from "@/data/health";
import { Meter } from "@/components/ui/meter";
import { ResourceStatus } from "@/components/status/ResourceStatus";
import { formatAge } from "@/lib/format";
import { cn } from "@/lib/cn";
import { t as tt } from "@/i18n";

const col = createColumnHelper<NodeRow>();

function Usage({ pct, label }: { pct: number | null; label: string }) {
  if (pct === null) return <span className="text-fg-muted" title={tt("No usage: the node does not report")}>—</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Meter value={pct / 100} label={`${label} ${pct}%`} />
      <span className={cn("min-w-[30px] text-right font-mono text-ui tabular-nums", pct >= 90 ? "text-status-critical" : pct >= 80 && "text-status-warning")}>
        {pct}%
      </span>
    </span>
  );
}

export const nodeColumns = [
  col.accessor((n) => healthRank[n.health], {
    id: "status",
    meta: { label: tt("Status"), width: 128, priority: 100, sortNote: tt("status · attention first") },
    sortingFn: (a, b) => healthRank[a.original.health] - healthRank[b.original.health] || a.original.name.localeCompare(b.original.name),
    cell: ({ row: { original: n } }) => <ResourceStatus health={n.health} label={n.status} title={n.reason} />,
  }),
  col.accessor("name", {
    meta: { label: tt("Name"), width: "fill", priority: 100, sortNote: tt("name") },
    cell: ({ getValue }) => (
      <span className="block truncate font-mono text-ui text-fg" title={getValue()}>
        {getValue()}
      </span>
    ),
  }),
  col.accessor("roles", {
    meta: { label: tt("Roles"), width: 62, priority: 50, sortNote: tt("roles") },
    cell: ({ getValue }) => <span className="block truncate">{getValue()}</span>,
  }),
  col.accessor("version", {
    meta: { label: tt("Version"), width: 58, priority: 40, sortNote: tt("version") },
    cell: ({ getValue }) => <span className="font-mono text-meta">{getValue()}</span>,
  }),
  col.accessor((n) => n.cpuPct ?? -1, {
    id: "cpu",
    meta: { label: tt("CPU used"), width: 88, priority: 80, sortNote: tt("CPU usage") },
    sortDescFirst: true,
    cell: ({ row: { original: n } }) => <Usage pct={n.cpuPct} label={tt("CPU used")} />,
  }),
  col.accessor((n) => n.memPct ?? -1, {
    id: "memory",
    meta: { label: tt("Memory used"), width: 88, priority: 80, sortNote: tt("memory usage") },
    sortDescFirst: true,
    cell: ({ row: { original: n } }) => <Usage pct={n.memPct} label={tt("Memory used")} />,
  }),
  col.accessor("pods", {
    meta: { label: tt("Pods"), width: 54, align: "right", priority: 70, sortNote: tt("pods") },
    cell: ({ row: { original: n } }) => `${n.pods}/${n.podCapacity}`,
  }),
  col.accessor((n) => n.taints.length, {
    id: "taints",
    meta: { label: tt("Taints"), width: 48, align: "right", priority: 60, sortNote: tt("taints") },
    cell: ({ row: { original: n } }) => (
      <span
        className={n.taints.length ? "text-status-progressing" : "text-fg-muted"}
        title={n.taints.map((t) => `${t.key}${t.value ? `=${t.value}` : ""}:${t.effect}`).join("\n") || undefined}
      >
        {n.taints.length}
      </span>
    ),
  }),
  col.accessor("ageSeconds", {
    id: "age",
    meta: { label: tt("Age"), width: 34, align: "right", priority: 30, sortNote: tt("age") },
    cell: ({ getValue }) => formatAge(getValue()),
  }),
];
