import { createColumnHelper } from "@tanstack/react-table";
import { shortRepo, type AppHealth, type GitOpsObject, type SyncState } from "@/data/gitops";
import { healthRank } from "@/data/health";
import type { Health } from "@/data/types";
import { StatusGlyph, healthTone } from "@/components/status/StatusGlyph";
import { EnvMarker } from "@/components/status/EnvironmentBadge";
import { formatAge } from "@/lib/format";
import { cn } from "@/lib/cn";

const col = createColumnHelper<GitOpsObject>();

const SYNC_TONE: Record<SyncState, string> = {
  Synced: "text-status-healthy",
  Applied: "text-status-healthy",
  OutOfSync: "text-status-warning",
  Failed: "text-status-critical",
  Unknown: "text-status-neutral",
};

/** Sync glyphs: check for in sync, arrow for drift (desired ≠ live). */
export function SyncStatus({ sync }: { sync: SyncState }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-[7px] text-ui font-medium", SYNC_TONE[sync])}>
      {sync === "OutOfSync" ? (
        <svg viewBox="0 0 12 12" aria-hidden="true" className="size-3 shrink-0">
          <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M3.6 6h4.8M6.6 4.2L8.4 6 6.6 7.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <StatusGlyph health={sync === "Failed" ? "failed" : sync === "Unknown" ? "unknown" : "completed"} className={SYNC_TONE[sync]} />
      )}
      <span className="truncate">{sync}</span>
    </span>
  );
}

const APP_HEALTH: Record<AppHealth, Health> = {
  Healthy: "healthy",
  Ready: "healthy",
  Degraded: "failed",
  "Not ready": "failed",
  Missing: "failed",
  Progressing: "progressing",
  Suspended: "paused",
};

export function AppHealthStatus({ health }: { health: AppHealth }) {
  const h = APP_HEALTH[health];
  return (
    <span className={cn("flex min-w-0 items-center gap-[7px] text-ui font-medium", healthTone[h])}>
      <StatusGlyph health={h} />
      <span className="truncate">{health}</span>
    </span>
  );
}

export const gitopsColumns = [
  col.accessor((o) => healthRank[o.health], {
    id: "sync",
    meta: { label: "Sync", width: 96, priority: 100, sortNote: "sync · attention first" },
    sortingFn: (a, b) => healthRank[a.original.health] - healthRank[b.original.health] || a.original.name.localeCompare(b.original.name),
    cell: ({ row: { original: o } }) => <SyncStatus sync={o.sync} />,
  }),
  col.accessor("appHealth", {
    id: "health",
    meta: { label: "Health", width: 96, priority: 90, sortNote: "health" },
    cell: ({ getValue }) => <AppHealthStatus health={getValue()} />,
  }),
  col.accessor("name", {
    meta: { label: "Name", width: "fill", priority: 100, sortNote: "name" },
    cell: ({ row: { original: o } }) => (
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium text-fg">{o.name}</span>
        <span className="truncate text-meta text-fg-muted">{o.kind}</span>
      </span>
    ),
  }),
  col.accessor("cluster", {
    meta: { label: "Cluster", width: 108, priority: 80, sortNote: "cluster" },
    cell: ({ row: { original: o } }) => (
      <span className="flex min-w-0 items-center gap-1.5">
        <EnvMarker env={o.env} />
        <span className="truncate">{o.cluster}</span>
      </span>
    ),
  }),
  col.accessor((o) => shortRepo(o), {
    id: "source",
    meta: { label: "Source", width: 170, priority: 40, sortNote: "source" },
    cell: ({ getValue }) => (
      <span className="block truncate font-mono text-ui" title={getValue()}>
        {getValue()}
      </span>
    ),
  }),
  col.accessor("revision", {
    meta: { label: "Revision", width: 64, priority: 60, sortNote: "revision" },
    cell: ({ getValue }) => <span className="block truncate font-mono text-ui">{getValue()}</span>,
  }),
  col.accessor("reconciledSeconds", {
    id: "reconciled",
    meta: { label: "Reconciled", width: 64, align: "right", priority: 50, sortNote: "last reconcile" },
    cell: ({ getValue }) => (getValue() < 3 ? "now" : formatAge(getValue())),
  }),
];
