import { useEffect, useMemo, useState } from "react";
import { getCoreRowModel, getSortedRowModel, useReactTable, type SortingState } from "@tanstack/react-table";
import { ArrowLeftRight, Box, KeyRound, Layers, Lock, Network, Search } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { clusterOverviews } from "@/data/clusterOverview";
import { isAttention } from "@/data/health";
import type { Cluster, Environment } from "@/data/types";
import { ResourceTable } from "@/components/resource-table/ResourceTable";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Kbd } from "@/components/ui/kbd";
import { Segmented } from "@/components/ui/segmented";
import { FilterToken } from "@/components/ui/filter-token";
import { InspectorPanel } from "@/components/ui/inspector-panel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { EmptyState } from "@/components/EmptyState";
import { isOffline } from "@/components/cluster/ClusterStates";
import { cn } from "@/lib/cn";
import { modKey } from "@/lib/platform";
import { clusterColumns, type ClusterRow } from "./columns";
import { ClusterInspector } from "./ClusterInspector";

const GROUP_LABEL: Record<Environment, string> = { prod: "Production", stg: "Staging", dev: "Development" };
const BAR = "bg-surface-panel dark:bg-transparent";

type StatusFilter = "any" | "connected" | "attention" | "offline";

/** Clusters that can be added to the selection (failing ones need a fix first). */
const selectable = (c: Cluster) => c.connection !== "auth-expired" && c.connection !== "unreachable";

/**
 * Every kubeconfig context, grouped by environment. The checkbox column is
 * the global cluster selection (shared with the sidebar and every explorer);
 * clicking a row opens its inspector.
 */
export function ClustersWorkspace({ active }: { active: boolean }) {
  const ws = useWorkspace();
  const { clusters, selectedClusterIds, setSelectedClusterIds, allPods, connectCluster, openView, reveal } = ws;
  const [show, setShow] = useState<"all" | "selected">("all");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<"all" | Environment>("all");
  const [status, setStatus] = useState<StatusFilter>("any");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>("prod-eu-west-1");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const selected = useMemo(() => new Set(selectedClusterIds), [selectedClusterIds]);

  const allRows = useMemo<ClusterRow[]>(
    () =>
      clusters.map((c) => {
        const pods = isOffline(c) ? [] : allPods.filter((p) => p.cluster === c.id);
        return {
          id: c.id,
          cluster: c,
          ov: clusterOverviews[c.id]!,
          pods: pods.length,
          podsAttention: pods.filter((p) => isAttention(p.health)).length,
        };
      }),
    [clusters, allPods],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allRows.filter(
      (r) =>
        (show === "all" || selected.has(r.id)) &&
        (group === "all" || r.cluster.env === group) &&
        (status === "any" ||
          (status === "connected" && r.cluster.connection === "connected") ||
          (status === "offline" && isOffline(r.cluster)) ||
          (status === "attention" && (r.podsAttention > 0 || !!r.ov.problems || isOffline(r.cluster)))) &&
        (!q || `${r.cluster.name} ${r.ov.provider} ${r.ov.region} ${r.ov.version}`.toLowerCase().includes(q)),
    );
  }, [allRows, show, selected, group, status, query]);

  const fix = (c: Cluster) => {
    if (c.connection === "auth-expired") openView({ kind: "connections", title: "Connections" });
    else connectCluster(c.id);
  };

  const columns = useMemo(() => clusterColumns(fix), [connectCluster, openView]);
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (r) => r.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  useEffect(() => {
    if (reveal?.kind !== "cluster") return;
    setSelectedId(reveal.id);
    setInspectorOpen(true);
  }, [reveal?.seq]);

  const connected = clusters.filter((c) => c.connection === "connected").length;
  const needAttention = allRows.filter((r) => isOffline(r.cluster) && r.cluster.connection !== "disconnected").length;
  const selectedRow = allRows.find((r) => r.id === selectedId);
  const selectedNames = clusters.filter((c) => selected.has(c.id)).map((c) => c.name);

  const setSelection = (ids: Set<string>) =>
    // ⌘A and group checkboxes select only clusters that can be used right now.
    setSelectedClusterIds([...ids].filter((id) => {
      const c = clusters.find((x) => x.id === id);
      return c ? selectable(c) : false;
    }));

  return (
    <div className="flex min-h-0 flex-1">
      <main className="@container flex min-w-0 flex-1 flex-col bg-surface-app">
        <div className={cn("flex h-12 shrink-0 items-center gap-2.5 border-b border-line pl-3.5 pr-3", BAR)}>
          <Network className="size-4" aria-hidden />
          <span className="text-title font-semibold">Clusters</span>
          <span className="truncate text-meta text-fg-muted">
            {clusters.length} contexts · {connected} connected · {needAttention} need attention
          </span>
          <div className="flex-1" />
          <Segmented
            aria-label="Show"
            value={show}
            onValueChange={setShow}
            options={[
              { value: "all", label: <>All {clusters.length}</> },
              { value: "selected", label: <>Selected {selected.size}</> },
            ]}
          />
          <Button onClick={() => openView({ kind: "connections", title: "Connections" })}>
            <KeyRound aria-hidden />
            Manage connections
          </Button>
        </div>

        <div className={cn("flex h-11 shrink-0 items-center gap-1.5 border-b border-line pl-3.5 pr-3", BAR)}>
          <label className="flex h-7 w-[240px] items-center gap-1.5 rounded-md border border-line-strong bg-surface-panel pl-2 pr-1.5 text-fg-muted focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
            <Search className="size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">Filter clusters</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter name, region, version…"
              className="min-w-0 flex-1 border-0 bg-transparent text-cell text-fg outline-none placeholder:text-fg-muted"
            />
            <Kbd>/</Kbd>
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FilterToken k="group" value={group === "all" ? "all" : GROUP_LABEL[group]} active={group !== "all"} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Environment group</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={group} onValueChange={(v) => setGroup(v as typeof group)}>
                <DropdownMenuRadioItem value="all">all</DropdownMenuRadioItem>
                {(["prod", "stg", "dev"] as const).map((e) => (
                  <DropdownMenuRadioItem key={e} value={e}>
                    {GROUP_LABEL[e]}
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
              <DropdownMenuRadioGroup value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
                <DropdownMenuRadioItem value="any">any</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="connected">connected</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="attention">needs attention</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="offline">not connected</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex-1" />
          <span className="hidden text-meta text-fg-muted @[900px]:inline">Usage from metrics-server · current values</span>
        </div>

        <ResourceTable
          table={table}
          aria-label="Clusters"
          rowHeight={46}
          fillMin={190}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setInspectorOpen(true);
          }}
          onDismiss={() => setInspectorOpen(false)}
          checked={selected}
          onCheckedChange={setSelection}
          rowClassName={(r) => (!selected.has(r.id) && isOffline(r.cluster) ? "!text-fg-muted" : undefined)}
          grouping={{
            keys: (["prod", "stg", "dev"] as const).filter((e) => rows.some((r) => r.cluster.env === e)),
            keyOf: (r) => r.cluster.env,
            collapsed,
            onToggle: (k) =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(k)) next.delete(k);
                else next.add(k);
                return next;
              }),
            renderLeading: (k, groupRows) => {
              const pickable = groupRows.filter((r) => selectable(r.cluster));
              const on = pickable.filter((r) => selected.has(r.id)).length;
              return (
                <Checkbox
                  aria-label={`Select ${GROUP_LABEL[k as Environment]}`}
                  checked={on === 0 ? false : on === pickable.length ? true : "indeterminate"}
                  onCheckedChange={(v) => {
                    const ids = new Set(selectedClusterIds);
                    for (const r of pickable) {
                      if (v) ids.add(r.id);
                      else ids.delete(r.id);
                    }
                    setSelectedClusterIds([...ids]);
                  }}
                />
              );
            },
            renderHeader: (k, groupRows) => {
              const on = groupRows.filter((r) => selected.has(r.id)).length;
              return (
                <>
                  <EnvironmentBadge env={k as Environment} />
                  <b className="font-semibold">{GROUP_LABEL[k as Environment]}</b>
                  <span className="text-meta text-fg-muted">
                    {groupRows.length} {groupRows.length === 1 ? "cluster" : "clusters"}
                    {on > 0 && on < groupRows.length ? ` · ${on} selected` : ""}
                  </span>
                  {groupRows.some((r) => r.cluster.protected) && (
                    <span className="flex items-center gap-1.5 text-meta text-env-prod-ink">
                      <Lock className="size-3" aria-hidden />
                      Protected
                    </span>
                  )}
                </>
              );
            },
          }}
          empty={<EmptyState title="No clusters match">Clear the filters to see every context.</EmptyState>}
        />

        {selected.size > 0 && (
          <div className="flex h-11 shrink-0 items-center gap-2 border-t border-line-selected bg-accent-soft pl-3.5 pr-3">
            <b className="text-cell font-semibold">
              {selected.size} {selected.size === 1 ? "cluster" : "clusters"} selected
            </b>
            <span className="hidden truncate text-meta text-fg-muted @[900px]:inline">{selectedNames.join(", ")}</span>
            <div className="flex-1" />
            <Button size="sm" onClick={() => openView({ kind: "pods", title: "Pods" })}>
              <Box aria-hidden />
              Open Pods
            </Button>
            <Button size="sm" onClick={() => openView({ kind: "deployments", title: "Deployments" })}>
              <Layers aria-hidden />
              Deployments
            </Button>
            <Button
              size="sm"
              disabled={selected.size < 2}
              title={selected.size < 2 ? "Select at least two clusters to compare" : undefined}
              onClick={() =>
                openView({
                  kind: "compare",
                  title: "Compare · checkout-api",
                  params: { kind: "Deployment", namespace: "payments", name: "checkout-api", clusters: [...selected].join(",") },
                })
              }
            >
              <ArrowLeftRight aria-hidden />
              Compare workload…
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelectedClusterIds([])}>
              Clear
            </Button>
          </div>
        )}
        <div className={cn("flex h-7 shrink-0 items-center gap-3.5 border-t border-line px-3.5 text-meta text-fg-muted", BAR)}>
          <span>Selection is shared with the sidebar and every explorer</span>
          <div className="flex-1" />
          <span>Space toggles · {modKey}A selects all that can connect</span>
        </div>
      </main>

      {inspectorOpen && selectedRow && (
        <InspectorPanel label="Cluster inspector" storageKey="clusters" active={active}>
          <ClusterInspector
            cluster={selectedRow.cluster}
            ov={selectedRow.ov}
            pods={selectedRow.pods}
            podsAttention={selectedRow.podsAttention}
            onClose={() => setInspectorOpen(false)}
          />
        </InspectorPanel>
      )}
    </div>
  );
}
