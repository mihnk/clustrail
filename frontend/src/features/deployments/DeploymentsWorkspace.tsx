import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { getCoreRowModel, getSortedRowModel, useReactTable, type SortingState } from "@tanstack/react-table";
import { ChevronDown, Columns3, Layers, Plus, Search, SearchX } from "lucide-react";
import { useNamespaceFilter } from "@/app/namespaceFilter";
import { useWorkspace } from "@/app/workspace";
import { useOverlays } from "@/app/shortcuts";
import { ROW_HEIGHT } from "@/app/preferences";
import { deploymentTotal, forbiddenNamespaces } from "@/data/mock";
import { backend } from "@/backend/client";
import { isAttention } from "@/data/health";
import type { DeploymentRow } from "@/data/types";
import { ResourceTable } from "@/components/resource-table/ResourceTable";
import { ModifyMenuButton } from "@/components/resource-actions/ResourceActions";
import { useConfirm } from "@/components/safety/ConfirmationDialog";
import { ClusterStateBanners, RbacBanner } from "@/components/cluster/ClusterStates";
import { ClusterPicker } from "@/components/cluster/ClusterPicker";
import { useClusterGrouping } from "@/components/cluster/useClusterGrouping";
import { Banner } from "@/components/ui/banner";
import { Button, IconButton } from "@/components/ui/button";
import { FilterToken } from "@/components/ui/filter-token";
import { InspectorPanel } from "@/components/ui/inspector-panel";
import { Kbd } from "@/components/ui/kbd";
import { Segmented } from "@/components/ui/segmented";
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
import { deploymentActions, type DeploymentActionDeps } from "./actions";
import { deploymentColumns, deploymentExplorerColumns } from "./columns";
import { DeploymentInspector, type DeploymentTab } from "./DeploymentInspector";

const BAR = "bg-surface-panel dark:bg-transparent";

export interface DeploymentNav {
  select?: (id: string) => void;
  showHistory?: () => void;
  focusScale?: () => void;
}

/** Builds the shared action dependencies for a Deployment row. */
export function useDeploymentDeps(nav: DeploymentNav) {
  const ws = useWorkspace();
  const { confirm } = useConfirm();
  return useCallback(
    (d: DeploymentRow): DeploymentActionDeps => {
      // Without an inspector here (protected list), history and scale open in the explorer.
      const inExplorer = (fn?: () => void) => () => {
        nav.select?.(d.id);
        if (fn) fn();
        else {
          ws.openView({ kind: "deployments", title: "Deployments" });
          ws.revealResource("deployment", d.id);
        }
      };
      return {
        cluster: ws.clusterById(d.cluster),
        confirm,
        restartDeployment: ws.restartDeployment,
        setDeploymentPaused: ws.setDeploymentPaused,
        deleteDeployment: ws.deleteDeployment,
        showHistory: inExplorer(nav.showHistory),
        focusScale: inExplorer(nav.focusScale),
        openYaml: (edit) =>
          ws.openView({
            kind: "yaml",
            title: `YAML · ${d.name}`,
            cluster: d.cluster,
            params: { kind: "Deployment", namespace: d.namespace, name: d.name, ...(edit ? { mode: "edit" } : {}) },
          }),
        compare: () =>
          ws.openView({
            kind: "compare",
            title: `Compare · ${d.name}`,
            params: { kind: "Deployment", namespace: d.namespace, name: d.name, clusters: ws.selectedClusterIds.join(",") },
          }),
      };
    },
    [ws, confirm, nav],
  );
}

export function DeploymentsWorkspace({ cluster, namespace, active }: { cluster: string; namespace: string; active: boolean }) {
  return cluster ? <ScopedDeployments cluster={cluster} namespace={namespace} /> : <DeploymentsExplorer active={active} />;
}

/** Deployments of one namespace in one cluster (e.g. a protected production context). */
function ScopedDeployments({ cluster: clusterId, namespace }: { cluster: string; namespace: string }) {
  const { deployments, clusterById, density, reveal } = useWorkspace();
  const cluster = clusterById(clusterId);
  const rows = useMemo(
    () => deployments.filter((d) => d.cluster === clusterId && (!namespace || d.namespace === namespace)),
    [deployments, clusterId, namespace],
  );
  const [sorting, setSorting] = useState<SortingState>([{ id: "status", desc: false }]);
  const [selectedId, setSelectedId] = useState<string | null>(rows[0]?.id ?? null);
  const nav = useMemo<DeploymentNav>(() => ({ select: setSelectedId }), []);
  const depsFor = useDeploymentDeps(nav);

  const table = useReactTable({
    data: rows,
    columns: deploymentColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (d) => d.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rowActions = useCallback(
    (id: string) => {
      const d = rows.find((r) => r.id === id);
      return d && cluster
        ? { actions: deploymentActions(d, depsFor(d)), target: { env: d.env, protected: cluster.protected, readOnly: cluster.readOnly } }
        : null;
    },
    [rows, cluster, depsFor],
  );

  useEffect(() => {
    if (reveal?.kind === "deployment" && rows.some((r) => r.id === reveal.id)) setSelectedId(reveal.id);
  }, [reveal?.seq]);

  const selected = rows.find((r) => r.id === selectedId) ?? null;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-app">
      <div className={cn("flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4", BAR)}>
        <Layers className="size-4" aria-hidden />
        <span className="text-title font-semibold">Deployments</span>
        <span className="text-cell text-fg-muted">
          {namespace || "all namespaces"} · {rows.length} of {backend ? deployments.filter((d) => d.cluster === clusterId).length : deploymentTotal}
        </span>
        <div className="flex-1" />
        {cluster && selected && (
          <ModifyMenuButton
            actions={deploymentActions(selected, depsFor(selected))}
            target={{ env: selected.env, protected: cluster.protected, readOnly: cluster.readOnly }}
            cluster={cluster.name}
          />
        )}
      </div>
      <ResourceTable
        table={table}
        aria-label={`Deployments in ${namespace} on ${clusterId}`}
        rowHeight={ROW_HEIGHT[density]}
        selectedId={selectedId}
        onSelect={setSelectedId}
        rowActions={rowActions}
        columnGap={10}
        paddingX={16}
      />
    </main>
  );
}

type HealthFilter = "all" | "attention";
type RolloutFilter = "any" | "attention" | "Progressing" | "Paused";

/** Deployments across the selected clusters, with an inspector. */
function DeploymentsExplorer({ active }: { active: boolean }) {
  const ws = useWorkspace();
  const { deployments, selectedClusters, selectedClusterIds, clusterById, density, reveal } = ws;
  const { clusterPickerOpen, setClusterPickerOpen } = useOverlays();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [namespaces, setNamespaces] = useNamespaceFilter();
  const [rolloutFilter, setRolloutFilter] = useState<RolloutFilter>("any");
  const [health, setHealth] = useState<HealthFilter>("all");
  const [view, setView] = useState<"aggregated" | "by-cluster">("aggregated");
  const [sorting, setSorting] = useState<SortingState>([{ id: "rollout", desc: false }]);
  const [selectedId, setSelectedId] = useState<string | null>("prod-eu-west-1/payments/checkout-api");
  const [autoHidden, setAutoHidden] = useState<string[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [tab, setTab] = useState<DeploymentTab>("overview");
  const [scaleFocusSeq, setScaleFocusSeq] = useState(0);
  const [held, setHeld] = useState(0);
  const [showForbidden, setShowForbidden] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const nav = useMemo<DeploymentNav>(
    () => ({
      select: (id: string) => {
        setSelectedId(id);
        setInspectorOpen(true);
      },
      showHistory: () => setTab("history"),
      focusScale: () => {
        setTab("overview");
        setScaleFocusSeq((n) => n + 1);
      },
    }),
    [],
  );
  const depsFor = useDeploymentDeps(nav);

  const inClusters = useMemo(() => deployments.filter((d) => selectedClusterIds.includes(d.cluster)), [deployments, selectedClusterIds]);
  const allNamespaces = useMemo(() => [...new Set(inClusters.map((d) => d.namespace))].sort(), [inClusters]);

  const baseRows = useMemo(() => {
    const words = deferredQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const tokens = words.filter((w) => w.includes(":"));
    const free = words.filter((w) => !w.includes(":"));
    return inClusters.filter((d) => {
      const hay = `${d.name} ${d.namespace} ${d.cluster} ${d.image} ${d.rollout}`.toLowerCase();
      return (
        (namespaces === null || namespaces.has(d.namespace)) &&
        (rolloutFilter === "any" || (rolloutFilter === "attention" ? isAttention(d.health) : d.rollout === rolloutFilter)) &&
        tokens.every((t) => {
          const [k, v = ""] = t.split(":", 2) as [string, string];
          if (k === "cluster") return d.cluster.includes(v);
          if (k === "ns" || k === "namespace") return d.namespace.includes(v);
          return hay.includes(t);
        }) &&
        free.every((w) => hay.includes(w))
      );
    });
  }, [inClusters, namespaces, rolloutFilter, deferredQuery]);
  const attention = baseRows.filter((d) => isAttention(d.health)).length;
  const rows = useMemo(() => (health === "attention" ? baseRows.filter((d) => isAttention(d.health)) : baseRows), [baseRows, health]);

  const grouped = view === "by-cluster";
  const grouping = useClusterGrouping<DeploymentRow>(grouped);
  const table = useReactTable({
    data: rows,
    columns: deploymentExplorerColumns,
    state: { sorting, columnVisibility: grouped ? { cluster: false } : {} },
    onSortingChange: setSorting,
    getRowId: (d) => d.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rowActions = useCallback(
    (id: string) => {
      const d = rows.find((r) => r.id === id);
      const c = d ? clusterById(d.cluster) : undefined;
      return d && c ? { actions: deploymentActions(d, depsFor(d)), target: { env: d.env, protected: c.protected, readOnly: c.readOnly } } : null;
    },
    [rows, clusterById, depsFor],
  );

  useEffect(() => {
    if (reveal?.kind === "deployment") {
      if (!rows.some((r) => r.id === reveal.id)) {
        setQuery("");
        setNamespaces(null);
        setRolloutFilter("any");
        setHealth("all");
      }
      setSelectedId(reveal.id);
      setInspectorOpen(true);
    } else if (reveal?.kind === "filter" && reveal.id.startsWith("deployments:")) {
      setQuery(reveal.id.slice("deployments:".length));
    }
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

  const selected = deployments.find((d) => d.id === selectedId) ?? null;
  const forbidden = (backend ? [] : forbiddenNamespaces).filter(
    (f) => selectedClusterIds.includes(f.cluster) && f.resource === "deployments",
  );
  const allConnected = selectedClusters.every((c) => c.connection === "connected");
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const d of inClusters) m[d.cluster] = (m[d.cluster] ?? 0) + 1;
    return m;
  }, [inClusters]);
  const nsLabel = namespaces === null ? (allNamespaces.length ? `${allNamespaces.length} selected` : "any") : `${namespaces.size} selected`;

  return (
    <div className="flex min-h-0 flex-1">
      <main className="@container flex min-w-0 flex-1 flex-col bg-surface-app">
        <div className={cn("flex h-12 shrink-0 items-center gap-2.5 border-b border-line pl-3.5 pr-3", BAR)}>
          <Button variant="ghost" className="gap-2 px-1.5 text-fg">
            <Layers className="!size-4" aria-hidden />
            <span className="text-title font-semibold">Deployments</span>
            <ChevronDown className="text-fg-muted" aria-hidden />
          </Button>
          <ClusterPicker open={active && clusterPickerOpen} onOpenChange={setClusterPickerOpen}>
            <button
              type="button"
              aria-label="Pick clusters"
              className="focus-ring hidden min-w-0 items-center gap-1.5 overflow-hidden rounded-md border-0 bg-transparent p-0 @[760px]:flex"
            >
              {selectedClusters.map((c) => (
                <span
                  key={c.id}
                  className="flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] border border-line bg-surface-elevated px-2 text-ui text-fg-secondary"
                >
                  <EnvMarker env={c.env} />
                  {c.name}
                </span>
              ))}
            </button>
          </ClusterPicker>
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
          <IconButton aria-label="Columns" disabled title="Column choice is available in the Pods explorer">
            <Columns3 />
          </IconButton>
          <span className="flex items-center gap-1.5 whitespace-nowrap text-ui text-fg-secondary">
            <ConnectionDot state={allConnected ? "connected" : "reconnecting"} />
            {allConnected ? "Live" : "Partial"}
          </span>
        </div>

        <div className={cn("flex h-11 shrink-0 items-center gap-1.5 border-b border-line pl-3.5 pr-3", BAR)}>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
            <label className="flex h-7 w-[200px] shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-surface-panel pl-2 pr-1.5 text-fg-muted focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
              <Search className="size-3.5 shrink-0" aria-hidden />
              <span className="sr-only">Filter deployments</span>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && (query ? setQuery("") : e.currentTarget.blur())}
                placeholder="Filter name, image, label…"
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
                {allNamespaces.map((ns) => (
                  <DropdownMenuCheckboxItem
                    key={ns}
                    checked={namespaces === null || namespaces.has(ns)}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={(on) => {
                      const next = new Set(namespaces ?? allNamespaces);
                      if (on) next.add(ns);
                      else next.delete(ns);
                      setNamespaces(next.size === allNamespaces.length ? null : next);
                    }}
                  >
                    {ns}
                  </DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setNamespaces(null)}>Select all</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <FilterToken
                  k="rollout"
                  value={rolloutFilter === "attention" ? "needs attention" : rolloutFilter}
                  active={rolloutFilter !== "any"}
                  className="hidden @[760px]:flex"
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Rollout</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={rolloutFilter} onValueChange={(v) => setRolloutFilter(v as RolloutFilter)}>
                  <DropdownMenuRadioItem value="any">any</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="attention">needs attention</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="Progressing">Progressing</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="Paused">Paused</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              onClick={() => searchRef.current?.focus()}
              title="Type tokens in the filter: ns:payments cluster:prod"
              className="focus-ring hidden h-[26px] items-center gap-1.5 whitespace-nowrap rounded-md border border-dashed border-line-strong bg-transparent px-2 text-ui text-fg-secondary @[860px]:flex"
            >
              <Plus className="size-3.5" aria-hidden />
              Filter
            </button>
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
                    Attention <span className="font-mono">{attention}</span>
                  </>
                ),
              },
            ]}
          />
        </div>

        <ClusterStateBanners clusters={selectedClusters} counts={counts} noun="deployments" />
        <RbacBanner clusters={selectedClusterIds} resource="deployments" />

        <ResourceTable
          table={table}
          aria-label="Deployments"
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
          holdOrderWhileHovered
          onHeldUpdatesChange={setHeld}
          fillMin={160}
          empty={
            <EmptyState icon={<SearchX />} title="No deployments match">
              Clear the filters or pick more clusters.
            </EmptyState>
          }
        />

        {forbidden.length > 0 && (
          <Banner
            tone="warning"
            className="shrink-0 rounded-none border-t border-line"
            action={
              <Button size="sm" variant="ghost" onClick={() => setShowForbidden(!showForbidden)}>
                {showForbidden ? "Hide" : "Details"}
              </Button>
            }
          >
            <b className="font-semibold">
              {forbidden.length} {forbidden.length === 1 ? "namespace" : "namespaces"} hidden:
            </b>{" "}
            {forbidden.map((f) => (
              <span key={f.cluster + f.namespace}>
                <span className="font-mono">{f.user}</span> can’t list {f.resource} in <span className="font-mono">{f.namespace}</span> on{" "}
                {f.cluster} (403 Forbidden)
              </span>
            ))}
            {showForbidden && (
              <span className="selectable mt-1 block font-mono text-meta text-fg-secondary">
                kubectl --context {forbidden[0]!.cluster} auth can-i list deployments -n {forbidden[0]!.namespace}
              </span>
            )}
          </Banner>
        )}

        <div className={cn("flex h-7 shrink-0 items-center gap-3.5 border-t border-line px-3.5 text-meta text-fg-muted", BAR)}>
          <span>
            <span className="text-fg">{rows.length}</span> deployments
          </span>
          {attention > 0 && <span className="text-status-critical">{attention} need attention</span>}
          {held > 0 && (
            <span className="flex items-center gap-1.5 text-status-progressing">
              <span className="size-1.5 rounded-full bg-status-progressing" />
              {held} {held === 1 ? "update" : "updates"} held while hovering
            </span>
          )}
          {grouped && <span>Grouped by cluster</span>}
          <div className="flex-1" />
          {autoHidden.length > 0 && <span className="truncate">{autoHidden.join(", ")} hidden at this width</span>}
        </div>
      </main>

      {inspectorOpen && selected && (
        <InspectorPanel label="Deployment inspector" storageKey="deployments" active={active}>
          <DeploymentInspector
            d={selected}
            cluster={clusterById(selected.cluster)}
            actions={deploymentActions(selected, depsFor(selected))}
            tab={tab}
            onTabChange={setTab}
            scaleFocusSeq={scaleFocusSeq}
            onClose={() => setInspectorOpen(false)}
          />
        </InspectorPanel>
      )}
    </div>
  );
}
