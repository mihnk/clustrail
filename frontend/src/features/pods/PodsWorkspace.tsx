import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { Box, ChevronDown, Columns3, Lock, Plus, Search, SearchX } from "lucide-react";
import { FilterToken, RemovableFilterToken } from "@/components/ui/filter-token";
import { Banner } from "@/components/ui/banner";
import { useConfirm } from "@/components/safety/ConfirmationDialog";
import { useWorkspace } from "@/app/workspace";
import { ROW_HEIGHT, usePersistentState } from "@/app/preferences";
import { getPodDetail } from "@/data/mock";
import { isAttention } from "@/data/health";
import { ResourceTable } from "@/components/resource-table/ResourceTable";
import { Button, IconButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Segmented } from "@/components/ui/segmented";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConnectionDot, EnvMarker, EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/cn";
import { podColumns } from "./columns";
import { matchesFilter, matchesLabel, parseFilter } from "./filter";
import { PodInspector, type InspectorTab } from "./PodInspector";
import { podActions } from "./actions";

type HealthFilter = "all" | "attention";
type OwnerFilter = "any" | "ReplicaSet" | "StatefulSet" | "Job" | "none";
type ClusterView = "aggregated" | "by-cluster";

/** Label pairs offered under "+ Filter"; anything else is typed as label:key=value. */
const SUGGESTED_LABEL_KEYS = ["tier", "app.kubernetes.io/part-of"];

/** Toolbars and footers sit on the panel surface in light theme, on the app surface in dark. */
const BAR = "bg-surface-panel dark:bg-transparent";

const INSPECTOR_MIN = 320;
const INSPECTOR_MAX = 640;

export function PodsWorkspace({ active }: { active: boolean }) {
  const { pods, selectedClusters, clusterById, density, theme, tabs, openTab, deployments, deletePod, restartDeployment } =
    useWorkspace();
  const { confirm } = useConfirm();

  // View state kept per tab: filters, sort, selection, inspector.
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [namespaces, setNamespaces] = useState<Set<string> | null>(null);
  const [owner, setOwner] = useState<OwnerFilter>("any");
  const [labelFilters, setLabelFilters] = useState<string[]>([]);
  const [view, setView] = useState<ClusterView>("aggregated");
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const [health, setHealth] = useState<HealthFilter>("all");
  const [sorting, setSorting] = useState<SortingState>([{ id: "status", desc: false }]);
  const [userColumns, setUserColumns] = useState<VisibilityState>({});
  const [selectedId, setSelectedId] = useState<string | null>("prod-eu-west-1/payments/checkout-api-7d9f8b6c4-x2kqp");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("overview");
  const [inspectorWidth, setInspectorWidth] = usePersistentState("inspectorWidth", 380);
  const [autoHidden, setAutoHidden] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  const allNamespaces = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of pods) counts.set(p.namespace, (counts.get(p.namespace) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => a.localeCompare(b));
  }, [pods]);

  const labelSuggestions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of pods) {
      for (const k of SUGGESTED_LABEL_KEYS) {
        const v = p.labels[k];
        if (v !== undefined) counts.set(`${k}=${v}`, (counts.get(`${k}=${v}`) ?? 0) + 1);
      }
    }
    return [...counts].sort(([a], [b]) => a.localeCompare(b));
  }, [pods]);

  // Everything except the health segment, so its counts stay meaningful.
  const baseRows = useMemo(() => {
    const f = parseFilter(deferredQuery);
    return pods.filter(
      (p) =>
        (namespaces === null || namespaces.has(p.namespace)) &&
        (owner === "any" || (owner === "none" ? p.owner === null : p.owner?.kind === owner)) &&
        labelFilters.every((l) => matchesLabel(p.labels, l)) &&
        matchesFilter(p, f),
    );
  }, [pods, namespaces, owner, labelFilters, deferredQuery]);
  const filtered = deferredQuery.trim() !== "" || namespaces !== null || owner !== "any" || labelFilters.length > 0;
  const attentionCount = useMemo(() => baseRows.filter((p) => isAttention(p.health)).length, [baseRows]);
  const rows = useMemo(
    () => (health === "attention" ? baseRows.filter((p) => isAttention(p.health)) : baseRows),
    [baseRows, health],
  );

  // Aggregated: the Node column gives way to the inspector. By cluster: the
  // group header names the cluster, so Node takes the Cluster column's place.
  const grouped = view === "by-cluster";
  const columnVisibility = useMemo<VisibilityState>(
    () =>
      grouped
        ? { ...userColumns, cluster: false, node: userColumns.node ?? true }
        : { ...userColumns, node: inspectorOpen ? false : (userColumns.node ?? true) },
    [userColumns, inspectorOpen, grouped],
  );

  const table = useReactTable({
    data: rows,
    columns: podColumns,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    getRowId: (p) => p.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const selectedPod = useMemo(() => pods.find((p) => p.id === selectedId) ?? null, [pods, selectedId]);
  const selectedVisible = selectedId !== null && rows.some((p) => p.id === selectedId);
  const detail = useMemo(() => (selectedPod ? getPodDetail(selectedPod) : null), [selectedPod]);

  const actionsFor = useCallback(
    (id: string) => {
      const pod = pods.find((p) => p.id === id);
      if (!pod) return null;
      const cluster = clusterById(pod.cluster);
      return {
        target: { env: pod.env, protected: cluster?.protected ?? false },
        actions: podActions(pod, {
          cluster,
          deployments,
          confirm,
          deletePod,
          restartDeployment,
          openTab,
          hasTab: (tabId) => tabs.some((t) => t.id === tabId),
        }),
      };
    },
    [pods, clusterById, deployments, confirm, deletePod, restartDeployment, openTab, tabs],
  );

  // "/" focuses the filter while this tab is active.
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

  const sortState = sorting[0];
  const sortColumn = sortState ? table.getColumn(sortState.id) : undefined;
  const sortNote = sortColumn
    ? sortState?.id === "status" && !sortState.desc
      ? "Sorted by status · attention first"
      : `Sorted by ${sortColumn.columnDef.meta?.sortNote ?? sortState?.id} · ${sortState?.desc ? "descending" : "ascending"}`
    : "Unsorted";

  const nsLabel =
    namespaces === null
      ? `${allNamespaces.length} selected`
      : namespaces.size === 1
        ? ([...namespaces][0] ?? "")
        : `${namespaces.size} selected`;

  const toggleNamespace = (ns: string, on: boolean) => {
    const next = new Set(namespaces ?? allNamespaces.map(([n]) => n));
    if (on) next.add(ns);
    else next.delete(ns);
    setNamespaces(next.size === allNamespaces.length ? null : next);
  };

  const clearFilters = () => {
    setQuery("");
    setNamespaces(null);
    setOwner("any");
    setLabelFilters([]);
    setHealth("all");
  };

  const grouping = useMemo(
    () =>
      grouped
        ? {
            keys: selectedClusters.map((c) => c.id),
            keyOf: (p: (typeof rows)[number]) => p.cluster,
            collapsed: collapsedGroups,
            onToggle: (key: string) =>
              setCollapsedGroups((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              }),
            renderHeader: (key: string, groupRows: typeof rows) => {
              const c = clusterById(key);
              const attn = groupRows.filter((p) => isAttention(p.health)).length;
              return (
                <>
                  {c && <EnvMarker env={c.env} />}
                  <span className="font-mono font-semibold text-fg">{key}</span>
                  {c && <EnvironmentBadge env={c.env} />}
                  {c?.protected && (
                    <span className="flex items-center gap-1.5 whitespace-nowrap text-meta text-env-prod-ink">
                      <Lock className="size-3" aria-hidden />
                      Protected
                    </span>
                  )}
                  <span className="truncate text-meta text-fg-muted">
                    {c?.connection === "connected" ? c.summary : "Not connected"}
                  </span>
                  <div className="flex-1" />
                  {attn > 0 && (
                    <span className="whitespace-nowrap text-meta text-status-critical">
                      {attn} {attn === 1 ? "needs" : "need"} attention
                    </span>
                  )}
                  <span className="font-mono text-meta text-fg-muted">{groupRows.length}</span>
                </>
              );
            },
          }
        : undefined,
    [grouped, selectedClusters, collapsedGroups, clusterById],
  );

  const offline = selectedClusters.filter((c) => c.connection !== "connected");
  const allConnected = offline.length === 0;

  return (
    <div className="flex min-h-0 flex-1">
      {/* Container queries below adapt the toolbars to the space left by the sidebar and inspector. */}
      <main className="@container flex min-w-0 flex-1 flex-col bg-surface-app">
        {/* Workspace toolbar */}
        <div className={cn("flex h-12 shrink-0 items-center gap-2.5 border-b border-line pl-3.5 pr-3", BAR)}>
          <Button variant="ghost" className="gap-2 px-1.5 text-fg">
            <Box className="!size-4" aria-hidden />
            <span className="text-title font-semibold">Pods</span>
            <ChevronDown className="text-fg-muted" aria-hidden />
          </Button>
          <Tooltip content={selectedClusters.map((c) => c.name).join(", ") || "No clusters selected"}>
            <span className="flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] border border-line bg-surface-elevated px-2 text-ui text-fg-secondary @[800px]:hidden">
              {selectedClusters.length} {selectedClusters.length === 1 ? "cluster" : "clusters"}
            </span>
          </Tooltip>
          <div className="hidden min-w-0 items-center gap-1.5 overflow-hidden @[800px]:flex">
            {selectedClusters.map((c) => (
              <span
                key={c.id}
                title={c.connection === "connected" ? undefined : "Not connected"}
                className={cn(
                  "flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] border border-line bg-surface-elevated px-2 text-ui text-fg-secondary",
                  c.connection !== "connected" && "text-fg-muted",
                )}
              >
                <EnvMarker env={c.env} />
                {c.name}
              </span>
            ))}
          </div>
          <div className="flex-1" />
          <Segmented<ClusterView>
            aria-label="Cluster view"
            value={view}
            onValueChange={setView}
            options={[
              { value: "aggregated", label: "Aggregated" },
              { value: "by-cluster", label: "By cluster" },
            ]}
          />
          <ColumnsMenu
            columns={table.getAllLeafColumns().map((c) => ({
              id: c.id,
              label: c.columnDef.meta?.label ?? c.id,
              locked: (c.columnDef.meta?.priority ?? 0) >= 100,
              visible: c.getIsVisible(),
              blockedNote:
                c.id === "node" && inspectorOpen && !grouped
                  ? "hidden while inspector is open"
                  : c.id === "cluster" && grouped
                    ? "shown as groups"
                    : undefined,
            }))}
            onToggle={(id, on) => setUserColumns((v) => ({ ...v, [id]: on }))}
          />
          <span className="flex items-center gap-1.5 whitespace-nowrap text-ui text-fg-secondary">
            <ConnectionDot state={allConnected ? "connected" : "reconnecting"} />
            {allConnected ? "Live" : "Partial"}
          </span>
        </div>

        {/* Filters */}
        <div className={cn("flex h-11 shrink-0 items-center gap-1.5 border-b border-line pl-3.5 pr-3", BAR)}>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
          <label className="flex h-7 w-[150px] shrink-0 items-center @[760px]:w-[180px] @[960px]:w-[210px] gap-1.5 rounded-md border border-line-strong bg-surface-panel pl-2 pr-1.5 text-fg-muted focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
            <Search className="size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">Filter pods</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (query) setQuery("");
                  else e.currentTarget.blur();
                }
              }}
              placeholder="Filter name, label, node…"
              spellCheck={false}
              className="min-w-0 flex-1 border-0 bg-transparent text-cell text-fg outline-none placeholder:text-fg-muted"
            />
            <Kbd>/</Kbd>
          </label>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FilterToken k="namespace" value={nsLabel} active={namespaces !== null} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Namespaces</DropdownMenuLabel>
              {allNamespaces.map(([ns, count]) => (
                <DropdownMenuCheckboxItem
                  key={ns}
                  checked={namespaces === null || namespaces.has(ns)}
                  onCheckedChange={(on) => toggleNamespace(ns, on)}
                  onSelect={(e) => e.preventDefault()}
                >
                  <span className="flex-1">{ns}</span>
                  <span className="font-mono text-label text-fg-muted">{count}</span>
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setNamespaces(null)}>Select all</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FilterToken
                k="owner"
                value={owner}
                active={owner !== "any"}
                // An inactive owner filter makes room for label filters on narrow widths.
                className={owner === "any" && labelFilters.length > 0 ? "hidden @[960px]:flex" : undefined}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Owner kind</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={owner} onValueChange={(v) => setOwner(v as OwnerFilter)}>
                <DropdownMenuRadioItem value="any">any</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="ReplicaSet">ReplicaSet</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="StatefulSet">StatefulSet</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="Job">Job</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="none">none</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {labelFilters.map((l) => (
            <RemovableFilterToken
              key={l}
              k="label"
              value={<span className="font-mono text-meta">{l}</span>}
              onRemove={() => setLabelFilters(labelFilters.filter((x) => x !== l))}
            />
          ))}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="focus-ring hidden h-[26px] items-center gap-1.5 whitespace-nowrap rounded-md border border-dashed border-line-strong bg-transparent px-2 text-ui text-fg-secondary @[760px]:flex"
              >
                <Plus className="size-3.5" aria-hidden />
                Filter
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuLabel>Label</DropdownMenuLabel>
              {labelSuggestions.map(([l, count]) => (
                <DropdownMenuCheckboxItem
                  key={l}
                  checked={labelFilters.includes(l)}
                  onCheckedChange={(on) => setLabelFilters(on ? [...labelFilters, l] : labelFilters.filter((x) => x !== l))}
                >
                  <span className="flex-1 truncate font-mono text-ui">{l}</span>
                  <span className="font-mono text-label text-fg-muted">{count}</span>
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => searchRef.current?.focus()}>
                <Search aria-hidden />
                <span>
                  Type <span className="font-mono text-ui">label:key=value</span> or <span className="font-mono text-ui">ns:</span>…
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          </div>
          <Segmented<HealthFilter>
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
                    Attention <span className="font-mono">{attentionCount}</span>
                  </>
                ),
              },
            ]}
          />
        </div>

        {offline.length > 0 && (
          <Banner tone="warning" className="mx-3 my-2 shrink-0">
            Results are incomplete: <span className="font-mono">{offline.map((c) => c.name).join(", ")}</span>{" "}
            {offline.length === 1 ? "is" : "are"} not connected. Showing pods from {selectedClusters.length - offline.length} of{" "}
            {selectedClusters.length} selected clusters.
          </Banner>
        )}

        <ResourceTable
          table={table}
          aria-label="Pods"
          rowHeight={ROW_HEIGHT[density]}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setInspectorOpen(true);
          }}
          onOpen={() => setInspectorOpen(true)}
          onDismiss={() => setInspectorOpen(false)}
          onAutoHiddenChange={setAutoHidden}
          rowActions={actionsFor}
          grouping={grouping}
          empty={
            <EmptyState
              icon={<SearchX />}
              title="No pods match"
              action={
                <Button onClick={clearFilters}>Clear filters</Button>
              }
            >
              {pods.length === 0 ? "No pods in the selected clusters." : "Nothing in the selected clusters matches the current filters."}
            </EmptyState>
          }
        />

        <div className={cn("flex h-7 shrink-0 items-center gap-3.5 border-t border-line px-3.5 text-meta text-fg-muted", BAR)}>
          <span>
            <span className="text-fg">{rows.length}</span> {filtered ? "pods match" : "pods"}
          </span>
          {attentionCount > 0 && <span className="text-status-critical">{attentionCount} need attention</span>}
          <span className="truncate">{grouped ? "Grouped by cluster · Cluster column replaced by Node" : sortNote}</span>
          {selectedId && !selectedVisible && inspectorOpen && <span className="text-status-warning">Selected pod is hidden by filters</span>}
          <div className="flex-1" />
          {autoHidden.length > 0 ? (
            <span className="truncate">{autoHidden.join(", ")} hidden at this width</span>
          ) : (
            !grouped &&
            inspectorOpen &&
            userColumns.node !== false && <span>Node column hidden while inspector is open</span>
          )}
        </div>
      </main>

      {inspectorOpen && detail && (
        <aside
          aria-label="Pod inspector"
          style={{ width: inspectorWidth }}
          className="relative flex shrink-0 flex-col overflow-hidden border-l border-line bg-surface-panel"
        >
          <ResizeHandle
            label="Resize inspector"
            value={inspectorWidth}
            min={INSPECTOR_MIN}
            max={INSPECTOR_MAX}
            onChange={setInspectorWidth}
          />
          <PodInspector
            detail={detail}
            cluster={clusterById(detail.pod.cluster)}
            actions={actionsFor(detail.pod.id)?.actions ?? []}
            tab={inspectorTab}
            onTabChange={setInspectorTab}
            onClose={() => setInspectorOpen(false)}
            onInvestigate={(target) => openTab(`inv-${target}`)}
            onOpenOwner={(kind, name) => kind === "Deployment" && openTab(`deploy-${name}`)}
            themeKey={theme}
          />
        </aside>
      )}
    </div>
  );
}

function ColumnsMenu({
  columns,
  onToggle,
}: {
  columns: { id: string; label: string; locked: boolean; visible: boolean; blockedNote?: string }[];
  onToggle: (id: string, visible: boolean) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton aria-label="Columns">
          <Columns3 />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Columns</DropdownMenuLabel>
        {columns.map((c) => (
          <DropdownMenuCheckboxItem
            key={c.id}
            checked={c.visible}
            disabled={c.locked || c.blockedNote !== undefined}
            onCheckedChange={(on) => onToggle(c.id, on)}
            onSelect={(e) => e.preventDefault()}
          >
            <span className="flex-1">{c.label}</span>
            {c.blockedNote && <span className="text-label text-fg-muted">{c.blockedNote}</span>}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
