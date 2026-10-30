import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { getCoreRowModel, getSortedRowModel, useReactTable, type SortingState } from "@tanstack/react-table";
import { Box, Ban, ChevronDown, Code, Filter, Plus, Search, SearchX, Server, SquareTerminal, Trash2 } from "lucide-react";
import { backend } from "@/backend/client";
import { openDebug } from "@/features/debug/DebugDialogs";
import { useWorkspace } from "@/app/workspace";
import { ROW_HEIGHT } from "@/app/preferences";
import { isAttention } from "@/data/health";
import type { NodeRow } from "@/data/nodes";
import { ResourceTable } from "@/components/resource-table/ResourceTable";
import type { ResourceAction } from "@/components/resource-actions/ResourceActions";
import { useConfirm, type ConfirmationRequest } from "@/components/safety/ConfirmationDialog";
import { ClusterStateBanners, RbacBanner } from "@/components/cluster/ClusterStates";
import { useClusterGrouping } from "@/components/cluster/useClusterGrouping";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/cn";
import type { Cluster } from "@/data/types";
import { nodeColumns } from "./columns";
import { NodeInspector } from "./NodeInspector";
import { DrainDialog } from "./DrainDialog";
import { t as tt } from "@/i18n";

const BAR = "bg-surface-panel dark:bg-transparent";

function cordonRequest(n: NodeRow, cluster: Cluster | undefined, cordon: boolean, onConfirm: () => void): ConfirmationRequest {
  const short = n.name.split(".")[0]!;
  return {
    action: cordon ? tt("Cordon node") : tt("Uncordon node"),
    targetName: short,
    icon: <Ban />,
    env: n.env,
    cluster: n.cluster,
    meta: tt("{n} pods", { n: n.pods }),
    protected: cluster?.protected ?? false,
    destructive: false,
    whatHappens: cordon
      ? tt("New pods won’t be scheduled on the node. Running pods keep running. Reversible with Uncordon.")
      : tt("The node accepts new pods again."),
    command: `kubectl --context ${n.cluster} ${cordon ? "cordon" : "uncordon"} ${n.name}`,
    confirmLabel: cordon ? tt("Cordon") : tt("Uncordon"),
    phrase: short,
    onConfirm,
  };
}

/** Nodes across the selected clusters: status, usage, taints, with cordon and drain. */
export function NodesWorkspace({ active }: { active: boolean }) {
  const ws = useWorkspace();
  const { nodes, selectedClusters, selectedClusterIds, clusterById, density, setNodeCordoned, drainNode, reveal } = ws;
  const { confirm } = useConfirm();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [role, setRole] = useState<"any" | "worker" | "system" | "gpu">("any");
  const [health, setHealth] = useState<"all" | "attention">("all");
  const [view, setView] = useState<"aggregated" | "by-cluster">("by-cluster");
  const [sorting, setSorting] = useState<SortingState>([{ id: "status", desc: false }]);
  const [selectedId, setSelectedId] = useState<string | null>("prod-eu-west-1/ip-10-42-3-17.eu-west-1.compute.internal");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [autoHidden, setAutoHidden] = useState<string[]>([]);
  const [drainId, setDrainId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const inClusters = useMemo(() => nodes.filter((n) => selectedClusterIds.includes(n.cluster)), [nodes, selectedClusterIds]);
  const baseRows = useMemo(() => {
    const words = deferredQuery.toLowerCase().split(/\s+/).filter(Boolean);
    return inClusters.filter(
      (n) =>
        (role === "any" || n.roles.includes(role)) &&
        words.every((w) => `${n.name} ${n.zone} ${n.instanceType} ${n.status} ${Object.entries(n.labels).flat().join(" ")}`.toLowerCase().includes(w)),
    );
  }, [inClusters, role, deferredQuery]);
  const attention = baseRows.filter((n) => isAttention(n.health) || n.health === "cordoned").length;
  const rows = useMemo(
    () => (health === "attention" ? baseRows.filter((n) => isAttention(n.health) || n.health === "cordoned") : baseRows),
    [baseRows, health],
  );

  const grouped = view === "by-cluster";
  const grouping = useClusterGrouping<NodeRow>(grouped);
  const table = useReactTable({
    data: rows,
    columns: nodeColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (n) => n.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const actionsFor = useCallback(
    (n: NodeRow): ResourceAction[] => {
      const c = clusterById(n.cluster);
      const cordoned = n.taints.some((t) => t.key === "node.kubernetes.io/unschedulable");
      return [
        {
          id: "pods",
          group: "observe",
          label: tt("Pods on node"),
          icon: <Box />,
          shortcut: "P",
          onSelect: () => {
            ws.openView({ kind: "pods", title: tt("Pods") });
            ws.revealResource("filter", `pods:node:${n.name.split(".")[0]} cluster:${n.cluster}`);
          },
        },
        {
          id: "yaml",
          group: "observe",
          label: tt("View YAML"),
          icon: <Code />,
          shortcut: "Y",
          onSelect: () => ws.openView({ kind: "yaml", title: `YAML · ${n.name.split(".")[0]}`, cluster: n.cluster, params: { kind: "Node", name: n.name } }),
        },
        {
          id: "shell",
          group: "observe",
          label: c?.readOnly ? tt("Node shell · read-only context") : tt("Node shell…"),
          icon: <SquareTerminal />,
          disabled: !backend || c?.readOnly || n.health === "failed",
          onSelect: () => openDebug({ kind: "node", cluster: n.cluster, node: n.name }),
        },
        {
          id: "cordon",
          group: "modify",
          label: cordoned ? tt("Uncordon…") : tt("Cordon…"),
          icon: <Ban />,
          shortcut: "⇧C",
          onSelect: () => confirm(cordonRequest(n, c, !cordoned, () => setNodeCordoned(n.id, !cordoned))),
        },
        { id: "drain", group: "modify", label: tt("Drain…"), icon: <Filter />, shortcut: "⇧D", disabled: n.health === "failed", onSelect: () => setDrainId(n.id) },
        { id: "delete", group: "modify", danger: true, label: tt("Delete node…"), icon: <Trash2 />, disabled: true },
      ];
    },
    [clusterById, confirm, setNodeCordoned, ws],
  );

  const rowActions = useCallback(
    (id: string) => {
      const n = rows.find((r) => r.id === id);
      const c = n ? clusterById(n.cluster) : undefined;
      return n && c ? { actions: actionsFor(n), target: { env: n.env, protected: c.protected, readOnly: c.readOnly } } : null;
    },
    [rows, clusterById, actionsFor],
  );

  useEffect(() => {
    if (reveal?.kind === "node") {
      setSelectedId(reveal.id);
      setInspectorOpen(true);
    } else if (reveal?.kind === "filter" && reveal.id.startsWith("nodes:")) {
      setQuery(reveal.id.slice("nodes:".length).replace(/cluster:\S+/, "").trim());
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

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const drainNodeRow = nodes.find((n) => n.id === drainId) ?? null;
  const notReady = inClusters.filter((n) => n.health === "failed").length;
  const cordoned = inClusters.filter((n) => n.health === "cordoned").length;
  const pressure = inClusters.filter((n) => n.health === "warning").length;
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const n of inClusters) m[n.cluster] = (m[n.cluster] ?? 0) + 1;
    return m;
  }, [inClusters]);

  return (
    <div className="flex min-h-0 flex-1">
      <main className="@container flex min-w-0 flex-1 flex-col bg-surface-app">
        <div className={cn("flex h-12 shrink-0 items-center gap-2.5 border-b border-line pl-3.5 pr-3", BAR)}>
          <Button variant="ghost" className="gap-2 px-1.5 text-fg">
            <Server className="!size-4" aria-hidden />
            <span className="text-title font-semibold">{tt("Nodes")}</span>
            <ChevronDown className="text-fg-muted" aria-hidden />
          </Button>
          <span className="truncate text-meta text-fg-muted">
            {tt("{nInClusters} nodes · {notReady} NotReady · {cordoned} cordoned · {pressure} under memory pressure", { nInClusters: inClusters.length, notReady, cordoned, pressure })}</span>
          <div className="flex-1" />
          <Segmented
            aria-label={tt("Cluster view")}
            value={view}
            onValueChange={setView}
            options={[
              { value: "aggregated", label: tt("Aggregated") },
              { value: "by-cluster", label: tt("By cluster") },
            ]}
          />
        </div>

        <div className={cn("flex h-11 shrink-0 items-center gap-1.5 border-b border-line pl-3.5 pr-3", BAR)}>
          <label className="flex h-7 w-[200px] shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-surface-panel pl-2 pr-1.5 text-fg-muted focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
            <Search className="size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">{tt("Filter nodes")}</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (query ? setQuery("") : e.currentTarget.blur())}
              placeholder={tt("Filter name, label, zone…")}
              spellCheck={false}
              className="min-w-0 flex-1 border-0 bg-transparent text-cell text-fg outline-none placeholder:text-fg-muted"
            />
            <Kbd>/</Kbd>
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FilterToken k="role" value={role} active={role !== "any"} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>{tt("Role")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={role} onValueChange={(v) => setRole(v as typeof role)}>
                {(["any", "worker", "system", "gpu"] as const).map((r) => (
                  <DropdownMenuRadioItem key={r} value={r}>
                    {r}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            onClick={() => searchRef.current?.focus()}
            title={tt("Labels, zones and instance types are searchable in the filter field")}
            className="focus-ring hidden h-[26px] items-center gap-1.5 whitespace-nowrap rounded-md border border-dashed border-line-strong bg-transparent px-2 text-ui text-fg-secondary @[760px]:flex"
          >
            <Plus className="size-3.5" aria-hidden />{tt("Filter")}</button>
          <div className="flex-1" />
          <Segmented
            aria-label={tt("Health")}
            value={health}
            onValueChange={setHealth}
            options={[
              { value: "all", label: <>{tt("All")}{" "}<span className="font-mono text-fg-muted">{baseRows.length}</span></> },
              {
                value: "attention",
                label: (
                  <>
                    <StatusGlyph health="failed" />{tt("Attention")}{" "}<span className="font-mono">{attention}</span>
                  </>
                ),
              },
            ]}
          />
        </div>

        <ClusterStateBanners clusters={selectedClusters} counts={counts} noun="nodes" />
        <RbacBanner clusters={selectedClusterIds} resource="nodes" />

        <ResourceTable
          table={table}
          aria-label={tt("Nodes")}
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
          fillMin={170}
          empty={
            <EmptyState icon={<SearchX />} title={tt("No nodes match")}>{tt("Clear the filters or pick more clusters.")}</EmptyState>
          }
        />

        <div className={cn("flex h-7 shrink-0 items-center gap-3.5 border-t border-line px-3.5 text-meta text-fg-muted", BAR)}>
          <span>
            <span className="text-fg">{rows.length}</span>{" "}{tt("nodes")}</span>
          {attention > 0 && <span className="text-status-critical">{tt("{attention} need attention", { attention })}</span>}
          <div className="flex-1" />
          {autoHidden.length > 0 && <span className="truncate">{tt("{v0} hidden at this width", { v0: autoHidden.join(", ") })}</span>}
          <span>{tt("Usage: metrics-server · Allocatable: node status")}</span>
        </div>
      </main>

      {inspectorOpen && selected && (
        <InspectorPanel label={tt("Node inspector")} storageKey="nodes" active={active}>
          <NodeInspector
            node={selected}
            cluster={clusterById(selected.cluster)}
            actions={actionsFor(selected)}
            onClose={() => setInspectorOpen(false)}
            onUncordon={() => confirm(cordonRequest(selected, clusterById(selected.cluster), false, () => setNodeCordoned(selected.id, false)))}
            onDrain={() => setDrainId(selected.id)}
          />
        </InspectorPanel>
      )}

      {drainNodeRow && (
        <DrainDialog
          node={drainNodeRow}
          cluster={clusterById(drainNodeRow.cluster)}
          onCancel={() => setDrainId(null)}
          onDrain={(opts) => {
            setDrainId(null);
            drainNode(drainNodeRow.id, opts);
          }}
        />
      )}
    </div>
  );
}
