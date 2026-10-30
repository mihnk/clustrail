import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { getCoreRowModel, getSortedRowModel, useReactTable, type SortingState } from "@tanstack/react-table";
import { History, LifeBuoy, Search, SearchX } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { ROW_HEIGHT } from "@/app/preferences";
import { isAttention } from "@/data/health";
import { planFromManifests, rollbackPlan, type HelmRelease, type HelmStatus, type RollbackPlan } from "@/data/helm";
import { ResourceTable } from "@/components/resource-table/ResourceTable";
import type { ResourceAction } from "@/components/resource-actions/ResourceActions";
import { useConfirm, type ConfirmationRequest } from "@/components/safety/ConfirmationDialog";
import { ClusterStateBanners } from "@/components/cluster/ClusterStates";
import { useClusterGrouping } from "@/components/cluster/useClusterGrouping";
import { FilterToken } from "@/components/ui/filter-token";
import { InspectorPanel } from "@/components/ui/inspector-panel";
import { Kbd } from "@/components/ui/kbd";
import { Segmented } from "@/components/ui/segmented";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { EmptyState } from "@/components/EmptyState";
import type { Cluster } from "@/data/types";
import { formatAge } from "@/lib/format";
import { cn } from "@/lib/cn";
import { backend, errorText } from "@/backend/client";
import { useToast } from "@/components/ui/toast";
import { helmColumns } from "./columns";
import { HelmInspector } from "./HelmInspector";

const BAR = "bg-surface-panel dark:bg-transparent";
/** Namespaces whose release Secrets this kubeconfig user cannot list (from a SelfSubjectAccessReview per namespace). */
const UNREADABLE_NAMESPACES = ["security", "vault"];

function rollbackRequest(r: HelmRelease, rev: number, plan: RollbackPlan, cluster: Cluster | undefined, onConfirm: () => void): ConfirmationRequest {
  const target = r.history.find((h) => h.rev === rev);
  return {
    action: "Roll back release",
    targetName: r.name,
    icon: <History />,
    env: r.env,
    cluster: r.cluster,
    namespace: r.namespace,
    meta: `revision ${r.revision} → ${rev} (${target?.chartVersion} · app ${target?.appVersion})`,
    protected: cluster?.protected ?? false,
    destructive: false,
    whatHappens: (
      <>
        Creates revision {r.revision + 1} with the manifest of revision {rev}. Changed: {plan.changed}.
        {plan.removed && <> Removed: {plan.removed}.</>}
        {plan.added && <> Added: {plan.added}.</>}
        {plan.hooks && <> Runs {plan.hooks}.</>} Waits up to 5m for resources to become ready.
      </>
    ),
    command: `helm rollback ${r.name} ${rev} -n ${r.namespace} --kube-context ${r.cluster} --wait --timeout 5m`,
    confirmLabel: `Roll back to ${rev}`,
    phrase: r.name,
    onConfirm,
  };
}

/** Helm releases across the selected clusters, read from release Secrets. */
export function HelmWorkspace({ active }: { active: boolean }) {
  const ws = useWorkspace();
  const { helmReleases, selectedClusters, selectedClusterIds, clusterById, density, rollbackRelease, reveal } = ws;
  const { confirm } = useConfirm();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [namespace, setNamespace] = useState("all");
  const [status, setStatus] = useState<"any" | HelmStatus>("any");
  const [health, setHealth] = useState<"all" | "attention">("all");
  const [view, setView] = useState<"aggregated" | "by-cluster">("aggregated");
  const [sorting, setSorting] = useState<SortingState>([{ id: "status", desc: false }]);
  const [selectedId, setSelectedId] = useState<string | null>("staging-eu-1/payments/payments-workers");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [autoHidden, setAutoHidden] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  const inClusters = useMemo(() => helmReleases.filter((r) => selectedClusterIds.includes(r.cluster)), [helmReleases, selectedClusterIds]);
  const namespaces = useMemo(() => [...new Set(inClusters.map((r) => r.namespace))].sort(), [inClusters]);
  const baseRows = useMemo(() => {
    const words = deferredQuery.toLowerCase().split(/\s+/).filter(Boolean);
    return inClusters.filter(
      (r) =>
        (namespace === "all" || r.namespace === namespace) &&
        (status === "any" || r.status === status) &&
        words.every((w) => `${r.name} ${r.chart}-${r.chartVersion} ${r.appVersion} ${r.namespace}`.toLowerCase().includes(w)),
    );
  }, [inClusters, namespace, status, deferredQuery]);
  const attention = baseRows.filter((r) => isAttention(r.health)).length;
  const rows = useMemo(() => (health === "attention" ? baseRows.filter((r) => isAttention(r.health)) : baseRows), [baseRows, health]);

  const grouping = useClusterGrouping<HelmRelease>(view === "by-cluster");
  const table = useReactTable({
    data: rows,
    columns: helmColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (r) => r.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const toast = useToast();
  const requestRollback = useCallback(
    async (r: HelmRelease, rev: number, known?: RollbackPlan) => {
      let plan = known ?? (backend ? null : rollbackPlan(r, rev));
      if (!plan && backend) {
        // From a row menu: read both stored revisions first, so the confirmation states what really changes.
        try {
          const [cur, tgt] = await Promise.all([backend.helmRevision(r.cluster, r.namespace, r.name, r.revision), backend.helmRevision(r.cluster, r.namespace, r.name, rev)]);
          plan = planFromManifests(cur.manifest, tgt.manifest, tgt.hooks);
        } catch (e) {
          toast.show({ kind: "error", title: "Could not read the revisions", target: r.name, detail: errorText(e), copyText: errorText(e) });
          return;
        }
      }
      confirm(rollbackRequest(r, rev, plan!, clusterById(r.cluster), () => rollbackRelease(r.id, rev)));
    },
    [confirm, clusterById, rollbackRelease, toast],
  );

  const actionsFor = useCallback(
    (r: HelmRelease): ResourceAction[] => {
      const lastGood = r.history.find((h) => h.rev !== r.revision && (h.status === "deployed" || h.status === "superseded"));
      return [
        {
          id: "rollback",
          group: "modify",
          label: lastGood ? `Roll back to ${lastGood.rev}…` : "Roll back…",
          icon: <History />,
          disabled: !lastGood,
          onSelect: () => lastGood && void requestRollback(r, lastGood.rev),
        },
      ];
    },
    [requestRollback],
  );

  const rowActions = useCallback(
    (id: string) => {
      const r = rows.find((x) => x.id === id);
      const c = r ? clusterById(r.cluster) : undefined;
      return r && c ? { actions: actionsFor(r), target: { env: r.env, protected: c.protected, readOnly: c.readOnly } } : null;
    },
    [rows, clusterById, actionsFor],
  );

  useEffect(() => {
    if (reveal?.kind === "filter" && reveal.id.startsWith("helm:")) setQuery(reveal.id.slice("helm:".length));
  }, [reveal?.seq]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || t?.closest("input, textarea, [contenteditable]")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const selected = helmReleases.find((r) => r.id === selectedId) ?? null;
  const unreadable = (ws.backendMeta?.forbidden ?? []).filter((f) => f.resource.startsWith("secrets") && selectedClusterIds.includes(f.cluster));
  const failed = inClusters.filter((r) => r.status === "failed").length;
  const stuck = inClusters.filter((r) => r.status === "pending-upgrade" && r.updatedSeconds > 3600);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of inClusters) m[r.cluster] = (m[r.cluster] ?? 0) + 1;
    return m;
  }, [inClusters]);

  return (
    <div className="flex min-h-0 flex-1">
      <main className="@container flex min-w-0 flex-1 flex-col bg-surface-app">
        <div className={cn("flex h-12 shrink-0 items-center gap-2.5 border-b border-line pl-3.5 pr-3", BAR)}>
          <LifeBuoy className="size-4" aria-hidden />
          <span className="text-title font-semibold">Helm releases</span>
          <span className="truncate text-meta text-fg-muted max-[1360px]:hidden">read from release Secrets in each namespace</span>
          <div className="flex-1" />
          <Segmented
            aria-label="Cluster view"
            value={view}
            onValueChange={setView}
            options={[
              { value: "aggregated", label: "Aggregated" },
              { value: "by-cluster", label: "By cluster" },
            ]}
          />
        </div>

        <div className={cn("flex h-11 shrink-0 items-center gap-1.5 border-b border-line pl-3.5 pr-3", BAR)}>
          <label className="flex h-7 w-[200px] shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-surface-panel pl-2 pr-1.5 text-fg-muted focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
            <Search className="size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">Filter releases</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (query ? setQuery("") : e.currentTarget.blur())}
              placeholder="Filter release, chart…"
              spellCheck={false}
              className="min-w-0 flex-1 border-0 bg-transparent text-cell text-fg outline-none placeholder:text-fg-muted"
            />
            <Kbd>/</Kbd>
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FilterToken k="namespace" value={namespace} active={namespace !== "all"} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[320px] overflow-y-auto">
              <DropdownMenuLabel>Namespace</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={namespace} onValueChange={setNamespace}>
                <DropdownMenuRadioItem value="all">all</DropdownMenuRadioItem>
                {namespaces.map((n) => (
                  <DropdownMenuRadioItem key={n} value={n}>
                    {n}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FilterToken k="status" value={status} active={status !== "any"} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Status</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={status} onValueChange={(v) => setStatus(v as typeof status)}>
                {(["any", "deployed", "failed", "pending-upgrade", "pending-rollback"] as const).map((s) => (
                  <DropdownMenuRadioItem key={s} value={s}>
                    {s}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex-1" />
          <Segmented
            aria-label="Health"
            value={health}
            onValueChange={setHealth}
            options={[
              { value: "all", label: <>All <span className="font-mono text-fg-muted">{baseRows.length}</span></> },
              {
                value: "attention",
                label: (
                  <>
                    <StatusGlyph health="failed" />
                    Attention <span className="font-mono">{attention}</span>
                  </>
                ),
              },
            ]}
          />
        </div>

        <ClusterStateBanners clusters={selectedClusters} counts={counts} noun="releases" />

        <ResourceTable
          table={table}
          aria-label="Helm releases"
          onAutoHiddenChange={setAutoHidden}
          rowHeight={ROW_HEIGHT[density]}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setInspectorOpen(true);
          }}
          onOpen={() => setInspectorOpen(true)}
          onDismiss={() => setInspectorOpen(false)}
          rowActions={rowActions}
          grouping={grouping}
          fillMin={150}
          empty={
            <EmptyState icon={<SearchX />} title="No releases match">
              Clear the filters or pick more clusters.
            </EmptyState>
          }
        />

        <div className={cn("flex h-7 shrink-0 items-center gap-3.5 border-t border-line px-3.5 text-meta text-fg-muted", BAR)}>
          <span>
            <span className="text-fg">{rows.length}</span> releases
          </span>
          {failed > 0 && <span className="text-status-critical">{failed} failed</span>}
          {stuck.map((r) => (
            <span key={r.id} className="text-status-progressing">
              1 pending-upgrade for {formatAge(r.updatedSeconds)} (lock held?)
            </span>
          ))}
          <div className="flex-1" />
          {autoHidden.length > 0 && <span className="truncate">{autoHidden.join(", ")} hidden at this width</span>}
          {backend ? (
            unreadable.length > 0 && (
              <span className="truncate max-[1360px]:hidden">
                Secrets not readable on {unreadable.map((f) => f.cluster).join(", ")} → releases there are not listed
              </span>
            )
          ) : (
            <span className="truncate max-[1360px]:hidden" title={UNREADABLE_NAMESPACES.join(", ")}>
              Secrets in {UNREADABLE_NAMESPACES.length} namespaces not readable → those releases are not listed
            </span>
          )}
        </div>
      </main>

      {inspectorOpen && selected && (
        <InspectorPanel label="Release inspector" storageKey="helm" defaultWidth={400} active={active}>
          <HelmInspector
            release={selected}
            cluster={clusterById(selected.cluster)}
            onClose={() => setInspectorOpen(false)}
            onRollback={(rev, plan) => void requestRollback(selected, rev, plan)}
          />
        </InspectorPanel>
      )}
    </div>
  );
}
