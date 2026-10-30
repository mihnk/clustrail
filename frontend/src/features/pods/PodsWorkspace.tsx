import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  useReactTable,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { Box, ChevronDown, Columns3, Lock, Plus, ScrollText, Search, SearchX, Trash2 } from "lucide-react";
import { ClusterStateBanners, RbacBanner, DisconnectedCluster, SkeletonRows, isOffline } from "@/components/cluster/ClusterStates";
import { ClusterPicker } from "@/components/cluster/ClusterPicker";
import { InspectorPanel } from "@/components/ui/inspector-panel";
import { useOverlays } from "@/app/shortcuts";
import { useClusterGrouping } from "@/components/cluster/useClusterGrouping";
import type { PodRow } from "@/data/types";
import { FilterToken, RemovableFilterToken } from "@/components/ui/filter-token";
import { useConfirm } from "@/components/safety/ConfirmationDialog";
import { useNamespaceFilter } from "@/app/namespaceFilter";
import { useWorkspace } from "@/app/workspace";
import { ROW_HEIGHT } from "@/app/preferences";
import { usePodDetail } from "@/backend/hooks";
import { backend } from "@/backend/client";
import { isAttention } from "@/data/health";
import { ResourceTable } from "@/components/resource-table/ResourceTable";
import { Button, IconButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Segmented } from "@/components/ui/segmented";
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
import { ConnectionDot, EnvMarker } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/cn";
import { podColumns } from "./columns";
import { matchesFilter, matchesLabel, parseFilter } from "./filter";
import { PodInspector, type InspectorTab } from "./PodInspector";
import { resourceTab } from "@/features/resources/kinds";
import { deploymentNameOf, podActions } from "./actions";
import { podSorter } from "./sort";
import { cachedCoreRowModel } from "@/lib/rowModel";
import { t as tt, tn } from "@/i18n";

type HealthFilter = "all" | "attention";
type OwnerFilter = "any" | "ReplicaSet" | "StatefulSet" | "Job" | "none";
type ClusterView = "aggregated" | "by-cluster";

/** Label pairs offered under "+ Filter"; anything else is typed as label:key=value. */
const SUGGESTED_LABEL_KEYS = ["tier", "app.kubernetes.io/part-of"];

/** Toolbars and footers sit on the panel surface in light theme, on the app surface in dark. */
const BAR = "bg-surface-panel dark:bg-transparent";


export function PodsWorkspace({ active }: { active: boolean }) {
  const {
    pods: allPods,
    selectedClusters,
    clusterById,
    density,
    theme,
    tabs,
    openTab,
    deployments,
    deletePod,
    restartDeployment,
    reveal,
    toggleCluster,
    openView,
    revealResource,
  } = useWorkspace();
  const { confirm } = useConfirm();
  const { clusterPickerOpen, setClusterPickerOpen } = useOverlays();

  // Rows as the cluster states allow: listing clusters have none yet (progressive
  // loading), reconnecting clusters keep their rows but mark them stale.
  const pods = useMemo<PodRow[]>(() => {
    const state = new Map(selectedClusters.map((c) => [c.id, c]));
    const out: PodRow[] = [];
    for (const p of allPods) {
      const c = state.get(p.cluster);
      if (!c || c.connection === "connecting") continue;
      if (c.connection === "reconnecting" && c.stale) {
        const age = Math.round((Date.now() - c.stale.since) / 1000);
        out.push({ ...p, health: "unknown" as const, status: `${p.status}?`, reason: tt("Last update {age}s ago", { age }), staleSeconds: age });
      } else out.push(p);
    }
    return out;
  }, [allPods, selectedClusters]);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  // View state kept per tab: filters, sort, selection, inspector.
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [namespaces, setNamespaces] = useNamespaceFilter();
  const [owner, setOwner] = useState<OwnerFilter>("any");
  const [labelFilters, setLabelFilters] = useState<string[]>([]);
  const [view, setView] = useState<ClusterView>("aggregated");
  const [health, setHealth] = useState<HealthFilter>("all");
  const [sorting, setSorting] = useState<SortingState>([{ id: "status", desc: false }]);
  const [userColumns, setUserColumns] = useState<VisibilityState>({});
  const [selectedId, setSelectedId] = useState<string | null>(backend ? null : "prod-eu-west-1/payments/checkout-api-7d9f8b6c4-x2kqp");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("overview");
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

  // Sorted here, not by TanStack (see sort.ts); TanStack keeps the header state.
  const sorter = useMemo(podSorter, []);
  const sortedRows = useMemo(() => sorter(rows, sorting), [sorter, rows, sorting]);
  const table = useReactTable({
    data: sortedRows,
    columns: podColumns,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    manualSorting: true,
    getRowId: (p) => p.id,
    getCoreRowModel: cachedCoreRowModel(),
  });

  const selectedPod = useMemo(() => pods.find((p) => p.id === selectedId) ?? null, [pods, selectedId]);
  // Only filters can hide a pod that is in the selected clusters.
  const selectedHiddenByFilters = selectedPod !== null && !rows.some((p) => p.id === selectedId);
  const detail = usePodDetail(selectedPod ?? null);

  const actionsFor = useCallback(
    (id: string) => {
      const pod = pods.find((p) => p.id === id);
      if (!pod) return null;
      const cluster = clusterById(pod.cluster);
      const actions = podActions(pod, {
          cluster,
          deployments,
          confirm,
          deletePod,
          restartDeployment,
          openResource: (cluster, kind, namespace, name) => openView(resourceTab(cluster, kind, namespace, name)),
          openYaml: (p) =>
            openView({
              kind: "yaml",
              title: `YAML · ${p.name.split("-").slice(-1)[0]}`,
              cluster: p.cluster,
              params: { kind: "Pod", namespace: p.namespace, name: p.name },
            }),
          openShell: (p) => {
            openView({ id: "shell", kind: "shell", title: "Shell", cluster: p.cluster });
            // Desktop: an empty container means the pod's default container.
            revealResource("session", `${p.cluster}/${p.namespace}/${p.name}/${backend ? "" : p.owner ? "api" : "app"}`);
          },
          openLogs: (p) =>
            openView({
              kind: "logs",
              title: `Logs · ${deploymentNameOf(p) ?? p.name}`,
              cluster: p.cluster,
              params: { namespace: p.namespace, workload: deploymentNameOf(p) ?? p.name },
            }),
        });
      return {
        target: { env: pod.env, protected: cluster?.protected ?? false, readOnly: cluster?.readOnly },
        // Stale rows: nothing acts on data that may no longer be true.
        actions: pod.staleSeconds !== undefined ? actions.map((a) => ({ ...a, disabled: true })) : actions,
      };
    },
    [pods, clusterById, deployments, confirm, deletePod, restartDeployment, openTab, openView, revealResource, tabs],
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
      ? tt("Sorted by status · attention first")
      : tt(sortState?.desc ? "Sorted by {column} · descending" : "Sorted by {column} · ascending", { column: sortColumn.columnDef.meta?.sortNote ?? sortState?.id })
    : tt("Unsorted");

  const nsLabel =
    namespaces === null
      ? allNamespaces.length === 0
        ? tt("any")
        : tt("{n} selected", { n: allNamespaces.length })
      : namespaces.size === 1
        ? ([...namespaces][0] ?? "")
        : tt("{n} selected", { n: namespaces.size });

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

  const grouping = useClusterGrouping<PodRow>(grouped);

  const allConnected = selectedClusters.every((c) => c.connection === "connected");
  const offline = selectedClusters.filter(isOffline);
  const listing = selectedClusters.filter((c) => c.connection === "connecting");
  const countsByCluster = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of pods) m[p.cluster] = (m[p.cluster] ?? 0) + 1;
    return m;
  }, [pods]);

  // A resource picked elsewhere (command palette, links): select it and make sure filters don't hide it.
  useEffect(() => {
    if (reveal?.kind === "filter" && reveal.id.startsWith("pods:")) {
      clearFilters();
      setQuery(reveal.id.slice("pods:".length));
      return;
    }
    if (reveal?.kind !== "pod") return;
    if (!rows.some((p) => p.id === reveal.id)) clearFilters();
    setSelectedId(reveal.id);
    setInspectorOpen(true);
  }, [reveal?.seq]);

  const checkedPods = checked.size === 0 ? [] : pods.filter((p) => checked.has(p.id));
  const bulkDelete = () => {
    const groups = [...new Set(checkedPods.map((p) => p.cluster))].map((id) => {
      const c = clusterById(id);
      return {
        cluster: id,
        env: c?.env ?? "dev",
        protected: c?.protected ?? false,
        items: checkedPods
          .filter((p) => p.cluster === id)
          .map((p) => ({
            name: `${p.namespace}/${p.name}`,
            health: p.health,
            note: p.owner && p.owner.kind !== "Job" ? tt("recreated by {v0}", { v0: p.owner.kind === "ReplicaSet" ? "RS" : p.owner.kind }) : tt("not replaced"),
          })),
      };
    });
    const n = checkedPods.length;
    confirm({
      title: tt(groups.length === 1 ? "Delete {n} pods in 1 cluster?" : "Delete {n} pods in {clusters} clusters?", { n, clusters: groups.length }),
      action: tt("Delete pods"),
      targetName: tt("{n} pods", { n }),
      icon: <Trash2 />,
      env: groups.some((g) => g.env === "prod") ? "prod" : groups.some((g) => g.env === "stg") ? "stg" : "dev",
      cluster: groups.map((g) => g.cluster).join(", "),
      protected: groups.some((g) => g.protected),
      destructive: true,
      targets: groups,
      phrase: `delete ${n} pods`,
      whatHappens: tt("Each pod is deleted with its default grace period. Pods owned by a controller are replaced; the others are not."),
      command: groups
        .map((g) => `kubectl --context ${g.cluster} delete pod ${g.items.map((i) => i.name.split("/")[1]).join(" ")}`)
        .join(" && "),
      confirmLabel: tt("Delete {n} pods", { n }),
      onConfirm: () => {
        checkedPods.forEach((p) => deletePod(p.id));
        setChecked(new Set());
      },
    });
  };
  const activeFilters = [
    deferredQuery.trim() && `“${deferredQuery.trim()}”`,
    health === "attention" && "status = attention",
    namespaces !== null && `namespace = ${[...namespaces].join(", ")}`,
    owner !== "any" && `owner = ${owner}`,
    ...labelFilters.map((l) => `label ${l}`),
  ].filter(Boolean);

  return (
    <div className="flex min-h-0 flex-1">
      {/* Container queries below adapt the toolbars to the space left by the sidebar and inspector. */}
      <main className="@container flex min-w-0 flex-1 flex-col bg-surface-app">
        {/* Workspace toolbar */}
        <div className={cn("flex h-12 shrink-0 items-center gap-2.5 border-b border-line pl-3.5 pr-3", BAR)}>
          <Button variant="ghost" className="gap-2 px-1.5 text-fg">
            <Box className="!size-4" aria-hidden />
            <span className="text-title font-semibold">{tt("Pods")}</span>
            <ChevronDown className="text-fg-muted" aria-hidden />
          </Button>
          <Tooltip content={selectedClusters.map((c) => c.name).join(", ") || tt("No clusters selected")}>
            <span className="flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] border border-line bg-surface-elevated px-2 text-ui text-fg-secondary @[800px]:hidden">
              {tt(selectedClusters.length === 1 ? "1 cluster" : "{n} clusters", { n: selectedClusters.length })}
            </span>
          </Tooltip>
          <ClusterPicker open={active && clusterPickerOpen} onOpenChange={setClusterPickerOpen}>
            <button
              type="button"
              aria-label={tt("Pick clusters")}
              className="focus-ring hidden min-w-0 items-center gap-1.5 overflow-hidden rounded-md border-0 bg-transparent p-0 @[800px]:flex"
            >
              {selectedClusters.map((c) => (
                <span
                  key={c.id}
                  title={c.connection === "connected" ? undefined : c.connection}
                  className={cn(
                    "flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] border border-line bg-surface-elevated px-2 text-ui text-fg-secondary",
                    c.connection !== "connected" && "text-fg-muted",
                  )}
                >
                  <EnvMarker env={c.env} />
                  {c.name}
                </span>
              ))}
            </button>
          </ClusterPicker>
          <div className="flex-1" />
          <Segmented<ClusterView>
            aria-label={tt("Cluster view")}
            value={view}
            onValueChange={setView}
            options={[
              { value: "aggregated", label: tt("Aggregated") },
              { value: "by-cluster", label: tt("By cluster") },
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
                  ? tt("hidden while inspector is open")
                  : c.id === "cluster" && grouped
                    ? tt("shown as groups")
                    : undefined,
            }))}
            onToggle={(id, on) => setUserColumns((v) => ({ ...v, [id]: on }))}
          />
          <span className="flex items-center gap-1.5 whitespace-nowrap text-ui text-fg-secondary">
            <ConnectionDot state={allConnected ? "connected" : "reconnecting"} />
            {allConnected ? tt("Live") : tt("Partial")}
          </span>
        </div>

        {/* Filters */}
        <div className={cn("flex h-11 shrink-0 items-center gap-1.5 border-b border-line pl-3.5 pr-3", BAR)}>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
          <label className="flex h-7 w-[150px] shrink-0 items-center @[760px]:w-[180px] @[960px]:w-[210px] gap-1.5 rounded-md border border-line-strong bg-surface-panel pl-2 pr-1.5 text-fg-muted focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
            <Search className="size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">{tt("Filter pods")}</span>
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
              placeholder={tt("Filter name, label, node…")}
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
              <DropdownMenuLabel>{tt("Namespaces")}</DropdownMenuLabel>
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
              <DropdownMenuItem onSelect={() => setNamespaces(null)}>{tt("Select all")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FilterToken
                k="owner"
                value={owner === "any" ? tt("any") : owner === "none" ? tt("none") : owner}
                active={owner !== "any"}
                // An inactive owner filter makes room for label filters on narrow widths.
                className={owner === "any" && labelFilters.length > 0 ? "hidden @[960px]:flex" : undefined}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>{tt("Owner kind")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={owner} onValueChange={(v) => setOwner(v as OwnerFilter)}>
                <DropdownMenuRadioItem value="any">{tt("any")}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="ReplicaSet">{tt("ReplicaSet")}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="StatefulSet">{tt("StatefulSet")}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="Job">{tt("Job")}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="none">{tt("none")}</DropdownMenuRadioItem>
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
                <Plus className="size-3.5" aria-hidden />{tt("Filter")}</button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuLabel>{tt("Label")}</DropdownMenuLabel>
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
                <span>{tn("Type {v0} or {v1}…", { v0: <span className="font-mono text-ui">label:key=value</span>, v1: <span className="font-mono text-ui">ns:</span> })}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          </div>
          <Segmented<HealthFilter>
            aria-label={tt("Health")}
            value={health}
            onValueChange={setHealth}
            options={[
              { value: "all", label: <>{tt("All")}{" "}<span className="font-mono text-fg-muted">{baseRows.length}</span></> },
              {
                value: "attention",
                label: (
                  <>
                    <StatusGlyph health="failed" />{tt("Attention")}{" "}<span className="font-mono">{attentionCount}</span>
                  </>
                ),
              },
            ]}
          />
        </div>

        <ClusterStateBanners clusters={selectedClusters} counts={countsByCluster} noun="pods" />
        <RbacBanner clusters={selectedClusters.map((c) => c.id)} resource="pods" />

        <ResourceTable
          table={table}
          aria-label={tt("Pods")}
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
          checked={checked}
          onCheckedChange={setChecked}
          rowClassName={(p) => (p.staleSeconds !== undefined ? "!text-fg-muted" : undefined)}
          after={listing.length > 0 ? <SkeletonRows count={4} rowHeight={ROW_HEIGHT[density]} /> : undefined}
          empty={
            offline.length > 0 && offline.length === selectedClusters.length ? (
              <div className="flex flex-col gap-3 p-4">
                {offline.map((c) => (
                  <DisconnectedCluster key={c.id} cluster={c} onRemove={() => toggleCluster(c.id, false)} />
                ))}
              </div>
            ) : listing.length > 0 ? null : selectedClusters.length === 0 ? (
              <EmptyState title={tt("No clusters selected")}>{tt("Pick clusters in the sidebar or with {v0}.", { v0: "⌘⇧C" })}</EmptyState>
            ) : activeFilters.length > 0 ? (
              <EmptyState icon={<SearchX />} title={tt("No pods match these filters")} action={<Button onClick={clearFilters}>{tt("Clear filters")}</Button>}>
                {activeFilters.join(" · ")} · {tt(selectedClusters.length === 1 ? "1 cluster" : "{n} clusters", { n: selectedClusters.length })}
              </EmptyState>
            ) : (
              <EmptyState title={tt("No pods")}>{tt("There are no pods in the selected clusters.")}</EmptyState>
            )
          }
        />

        {checked.size > 0 && (
          <div className="flex h-11 shrink-0 items-center gap-2 border-t border-line-selected bg-accent-soft pl-3.5 pr-3">
            <b className="text-cell font-semibold">{checked.size}{" "}{tt("selected")}</b>
            <span className="text-meta text-fg-muted">
              {new Set(checkedPods.map((p) => p.cluster)).size}{" "}{tt("clusters")}</span>
            <div className="flex-1" />
            <Button size="sm" disabled title={tt("The Logs workspace opens for several pods once it is implemented.")}>
              <ScrollText aria-hidden />{tt("Logs")}</Button>
            <Button
              size="sm"
              variant={checkedPods.some((p) => clusterById(p.cluster)?.protected) ? "locked" : "default"}
              disabled={checkedPods.some((p) => clusterById(p.cluster)?.readOnly || p.staleSeconds !== undefined)}
              onClick={bulkDelete}
            >
              {checkedPods.some((p) => clusterById(p.cluster)?.protected) ? <Lock aria-hidden /> : <Trash2 aria-hidden />}{tt("Delete…")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setChecked(new Set())}>{tt("Clear")}</Button>
          </div>
        )}

        <div className={cn("flex h-7 shrink-0 items-center gap-3.5 border-t border-line px-3.5 text-meta text-fg-muted", BAR)}>
          <span>
            <span className="text-fg">{rows.length}</span> {filtered ? tt("pods match") : "pods"}
          </span>
          {attentionCount > 0 && <span className="text-status-critical">{tt("{attentionCount} need attention", { attentionCount })}</span>}
          <span className="truncate">{grouped ? tt("Grouped by cluster · Cluster column replaced by Node") : sortNote}</span>
          {selectedHiddenByFilters && inspectorOpen && <span className="text-status-warning">{tt("Selected pod is hidden by filters")}</span>}
          <div className="flex-1" />
          {autoHidden.length > 0 ? (
            <span className="truncate">{tt("{v0} hidden at this width", { v0: autoHidden.join(", ") })}</span>
          ) : (
            !grouped &&
            inspectorOpen &&
            userColumns.node !== false && <span>{tt("Node column hidden while inspector is open")}</span>
          )}
        </div>
      </main>

      {inspectorOpen && detail && (
        <InspectorPanel label={tt("Pod inspector")} storageKey="pods" active={active}>
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
        </InspectorPanel>
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
        <IconButton aria-label={tt("Columns")}>
          <Columns3 />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{tt("Columns")}</DropdownMenuLabel>
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
