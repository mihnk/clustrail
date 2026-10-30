import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createColumnHelper, getCoreRowModel, getSortedRowModel, useReactTable, type SortingState } from "@tanstack/react-table";
import { Cable, PanelTop, Check, Code, Copy, LayoutGrid, Pencil, Plus, RefreshCw, Search, SearchX, Trash2, X } from "lucide-react";
import { openPortForward } from "@/features/portforward/PortForward";
import { useNamespaceFilter } from "@/app/namespaceFilter";
import { SYSTEM_NAMESPACES, useWorkspace, type WorkspaceTab } from "@/app/workspace";
import { ROW_HEIGHT } from "@/app/preferences";
import { backend, errorText, EVENTS, onEvent, type GenericList, type GenericRow, type ListUpdate } from "@/backend/client";
import { usePersistentState } from "@/app/preferences";
import { useEvents } from "@/backend/hooks";
import type { Environment } from "@/data/types";
import { ResourceTable } from "@/components/resource-table/ResourceTable";
import { ModifyMenuButton, type ResourceAction } from "@/components/resource-actions/ResourceActions";
import { useConfirm } from "@/components/safety/ConfirmationDialog";
import { ClusterStateBanners } from "@/components/cluster/ClusterStates";
import { Banner } from "@/components/ui/banner";
import { Button, IconButton } from "@/components/ui/button";
import { InspectorPanel } from "@/components/ui/inspector-panel";
import { Kbd } from "@/components/ui/kbd";
import { FilterToken } from "@/components/ui/filter-token";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabCount } from "@/components/ui/tabs";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { useToast } from "@/components/ui/toast";
import { EmptyState } from "@/components/EmptyState";
import { EventsPanel } from "@/features/pods/PodInspector";
import { formatAge } from "@/lib/format";
import { cn } from "@/lib/cn";
import { kindName, kubectlResource, listLabel, resourceTab } from "./kinds";

const BAR = "bg-surface-panel dark:bg-transparent";

/** A row with the cluster's environment, for the table and its actions. */
interface Row extends GenericRow {
  env: Environment;
  ageSec: number;
}

/** Cells whose text signals trouble, from the server's own columns. */
const BAD = /^(Warning|Failed|BackOff|CrashLoopBackOff|Error|False|Pending|0\/[1-9])/;

/**
 * Keeps one kind current in each cluster: a watch (or a 30 s list in poll
 * mode) per cluster while the tab is active. Errors are per cluster so one 403
 * hides nothing else.
 */
function useGenericLists(clusters: string[], kind: string, active: boolean) {
  const [lists, setLists] = useState<Record<string, GenericList>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [modes, setModes] = useState<Record<string, "watch" | "poll">>({});
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const key = clusters.join(",");
  useEffect(() => {
    if (!backend || !active) return;
    const api = backend;
    const ids = new Map<string, string>(); // watch id → cluster
    const early: ListUpdate[] = [];
    let cancelled = false;
    setLoading(true);
    const apply = (u: ListUpdate) => {
      setModes((m) => (m[u.cluster] === u.mode ? m : { ...m, [u.cluster]: u.mode }));
      if (u.error) {
        setErrors((e) => ({ ...e, [u.cluster]: u.error! }));
        return;
      }
      setErrors((e) => {
        if (!(u.cluster in e)) return e;
        const next = { ...e };
        delete next[u.cluster];
        return next;
      });
      setLists((all) => {
        const cur = all[u.cluster];
        if (u.reset || !cur) {
          return { ...all, [u.cluster]: { cluster: u.cluster, kind, namespaced: u.namespaced, columns: u.columns ?? cur?.columns ?? [], rows: u.upserts, truncated: u.truncated, shown: u.shown } };
        }
        const del = new Set(u.deletes);
        const up = new Map(u.upserts.map((r) => [r.id, r]));
        const rows = cur.rows.filter((r) => !del.has(r.id) && !up.has(r.id)).concat(u.upserts);
        return { ...all, [u.cluster]: { ...cur, rows, truncated: u.truncated ?? cur.truncated, shown: u.shown ?? cur.shown } };
      });
      if (u.reset) setLoading(false);
    };
    const off = onEvent<ListUpdate>(EVENTS.list, (u) => {
      if (ids.has(u.id)) apply(u);
      else early.push(u);
    });
    setLists({});
    setErrors({});
    if (!clusters.length) setLoading(false);
    for (const c of clusters) {
      api
        .startListWatch(c, kind, "")
        .then((id) => {
          if (cancelled) return void api.stopListWatch(id);
          ids.set(id, c);
          early.filter((u) => u.id === id).forEach(apply);
        })
        .catch((e) => {
          if (cancelled) return;
          setErrors((all) => ({ ...all, [c]: errorText(e) }));
          setLoading(false);
        });
    }
    return () => {
      cancelled = true;
      off();
      for (const id of ids.keys()) void api.stopListWatch(id);
    };
  }, [key, kind, active, tick]);
  return { lists, errors, modes, loading, refresh: () => setTick((n) => n + 1) };
}

/** Any kind the cluster serves, with the API server's own columns (kubectl get). */
export function ResourceListWorkspace({ tab, active }: { tab: WorkspaceTab; active: boolean }) {
  const ws = useWorkspace();
  const { selectedClusters, clusterById, density } = ws;
  const { confirm } = useConfirm();
  const toast = useToast();
  const kind = tab.params?.kind ?? "Service";
  const label = listLabel(kind);
  const connected = selectedClusters.filter((c) => c.connection === "connected").map((c) => c.id);
  const { lists, errors, modes, loading, refresh } = useGenericLists(connected, kind, active);
  const [hideSystem] = usePersistentState("settings.hideSystemNamespaces", true);
  const [namespaces, setNamespaces] = useNamespaceFilter();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [wide, setWide] = useState(false);
  const [sorting, setSorting] = useState<SortingState>(kind === "Event" ? [] : [{ id: "name", desc: false }]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [autoHidden, setAutoHidden] = useState<string[]>([]);
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  // Columns come from the first cluster that answered; other clusters' cells are matched by column name.
  const listed = connected.map((c) => lists[c]).filter((l): l is GenericList => !!l);
  const columns = useMemo(() => (listed[0]?.columns ?? []).filter((c) => wide || c.priority === 0), [listed[0]?.columns, wide]);
  const namespaced = listed[0]?.namespaced ?? true;
  const multi = connected.length > 1;

  const allRows = useMemo<Row[]>(() => {
    const now = Date.now();
    return listed.flatMap((l) => {
      const env = clusterById(l.cluster)?.env ?? "dev";
      const index = columns.map((c) => l.columns.findIndex((x) => x.name === c.name));
      return l.rows
        .filter((r) => !deleted.has(r.id))
        .map((r) => ({
          ...r,
          cells: index.map((i) => (i >= 0 ? (r.cells[i] ?? "") : "")),
          env,
          ageSec: r.created ? Math.max(0, Math.round((now - Date.parse(r.created)) / 1000)) : -1,
        }));
    });
  }, [lists, columns, deleted, clusterById]);
  const allNamespaces = useMemo(
    () => [...new Set(allRows.map((r) => r.namespace ?? "").filter((ns) => ns && !(hideSystem && SYSTEM_NAMESPACES.includes(ns))))].sort(),
    [allRows, hideSystem],
  );
  const rows = useMemo(() => {
    const words = deferredQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const inNs = (r: Row) =>
      !r.namespace || (!(hideSystem && SYSTEM_NAMESPACES.includes(r.namespace)) && (namespaces === null || namespaces.has(r.namespace)));
    if (!words.length) return allRows.filter(inNs);
    return allRows.filter(inNs).filter((r) => {
      const hay = `${r.name} ${r.namespace ?? ""} ${r.cluster} ${r.cells.join(" ")} ${Object.entries(r.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(" ")}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [allRows, deferredQuery, namespaces, hideSystem]);

  const tableColumns = useMemo(() => {
    const col = createColumnHelper<Row>();
    const width = (i: number, name: string) => {
      const longest = Math.max(name.length, ...allRows.slice(0, 200).map((r) => (r.cells[i] ?? "").length));
      return Math.min(260, Math.max(56, Math.round(longest * 7 + 16)));
    };
    return [
      col.accessor("name", {
        meta: { label: "Name", width: "fill", priority: 100, sortNote: "name" },
        cell: ({ getValue }) => (
          <span className="block truncate font-mono text-ui text-fg" title={getValue()}>
            {getValue()}
          </span>
        ),
      }),
      ...(namespaced
        ? [
            col.accessor((r) => r.namespace ?? "", {
              id: "namespace",
              meta: { label: "Namespace", width: 130, priority: 70, sortNote: "namespace" },
              cell: ({ getValue }) => <span className="block truncate">{getValue()}</span>,
            }),
          ]
        : []),
      ...(multi
        ? [
            col.accessor("cluster", {
              meta: { label: "Cluster", width: 130, priority: 60, sortNote: "cluster" },
              cell: ({ row: { original: r } }) => (
                <span className="flex min-w-0 items-center gap-1.5">
                  <EnvironmentBadge env={r.env} />
                  <span className="truncate">{r.cluster}</span>
                </span>
              ),
            }),
          ]
        : []),
      ...columns.map((c, i) =>
        col.accessor((r) => r.cells[i] ?? "", {
          id: `c:${c.name}`,
          meta: { label: c.name, width: width(i, c.name), priority: 50 - i, sortNote: c.name.toLowerCase() },
          sortingFn: c.type === "integer" || c.type === "number" ? (a, b) => Number(a.original.cells[i]) - Number(b.original.cells[i]) : "alphanumeric",
          cell: ({ getValue }) => (
            <span className={cn("block truncate", c.type === "integer" || c.type === "number" ? "font-mono tabular-nums" : "", BAD.test(getValue()) && "text-status-warning")} title={getValue()}>
              {getValue() || <span className="text-fg-muted">—</span>}
            </span>
          ),
        }),
      ),
      col.accessor("ageSec", {
        id: "age",
        meta: { label: "Age", width: 52, align: "right", priority: 90, sortNote: "age" },
        cell: ({ getValue }) => <span className="font-mono text-meta text-fg-muted">{getValue() < 0 ? "—" : formatAge(getValue())}</span>,
      }),
    ];
  }, [columns, namespaced, multi, allRows.length > 0]);

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (r) => r.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const command = (r: Row, verb: string) =>
    `kubectl --context ${clusterById(r.cluster)?.context ?? r.cluster} ${verb} ${kubectlResource(kind)} ${r.name}${r.namespace ? ` -n ${r.namespace}` : ""}`;

  const actionsFor = useCallback(
    (r: Row): ResourceAction[] => {
      const c = clusterById(r.cluster);
      const params = { kind, namespace: r.namespace ?? "", name: r.name };
      return [
        { id: "open", group: "observe", label: "Open in tab", icon: <PanelTop />, onSelect: () => ws.openView(resourceTab(r.cluster, kind, r.namespace ?? "", r.name)) },
        { id: "yaml", group: "observe", label: "View YAML", icon: <Code />, shortcut: "Y", onSelect: () => ws.openView({ kind: "yaml", title: `YAML · ${r.name}`, cluster: r.cluster, params }) },
        ...(kind === "Service"
          ? [{ id: "forward", group: "observe" as const, label: "Port forward…", icon: <Cable />, onSelect: () => openPortForward({ cluster: r.cluster, namespace: r.namespace ?? "", kind: "Service", name: r.name }) }]
          : []),
        { id: "edit", group: "modify", label: "Edit YAML…", icon: <Pencil />, onSelect: () => ws.openView({ kind: "yaml", title: `YAML · ${r.name}`, cluster: r.cluster, params: { ...params, mode: "edit" } }) },
        {
          id: "delete",
          group: "modify",
          danger: true,
          label: "Delete…",
          icon: <Trash2 />,
          disabled: kind === "Event",
          onSelect: () =>
            confirm({
              action: `Delete ${kindName(kind)}`,
              targetName: r.name,
              icon: <Trash2 />,
              env: r.env,
              cluster: r.cluster,
              namespace: r.namespace,
              protected: c?.protected ?? false,
              destructive: true,
              whatHappens: <>The {kindName(kind)} is deleted. Objects it owns are removed by the garbage collector in the background, like kubectl.</>,
              command: command(r, "delete"),
              confirmLabel: "Delete",
              phrase: `${r.cluster}/${r.name}`,
              onConfirm: () => {
                if (!backend) return;
                backend
                  .deleteResource(r.cluster, kind, r.namespace ?? "", r.name)
                  .then(() => {
                    setDeleted((s) => new Set(s).add(r.id));
                    toast.show({ kind: "success", title: `${kindName(kind)} deleted`, target: `${r.name} · ${r.cluster}`, env: r.env });
                    refresh();
                  })
                  .catch((e) => toast.show({ kind: "error", title: "Delete failed", target: `${r.name} · ${r.cluster}`, detail: errorText(e), copyText: errorText(e) }));
              },
            }),
        },
      ];
    },
    [clusterById, confirm, kind, ws, toast],
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

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of allRows) m[r.cluster] = (m[r.cluster] ?? 0) + 1;
    return m;
  }, [allRows]);
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const limited = listed.filter((l) => l.shown);
  const truncated = listed.filter((l) => l.truncated);
  const hiddenWide = (listed[0]?.columns ?? []).filter((c) => c.priority > 0).length;

  if (!backend) {
    return (
      <EmptyState className="flex-1" icon={<LayoutGrid />} title={label}>
        Lists of any kind read the cluster’s API server, so they need the desktop app. The browser preview has sample data for Pods, Deployments, Nodes, Helm and GitOps only.
      </EmptyState>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <main className="@container flex min-w-0 flex-1 flex-col bg-surface-app">
        <div className={cn("flex h-12 shrink-0 items-center gap-2.5 border-b border-line pl-3.5 pr-3", BAR)}>
          <LayoutGrid className="size-4 text-fg-secondary" aria-hidden />
          <span className="text-title font-semibold">{label}</span>
          <span className="truncate font-mono text-meta text-fg-muted">{kind}</span>
          <div className="flex-1" />
          <Button size="sm" onClick={() => ws.openView({ kind: "create", title: `New ${kindName(kind)}`, params: { kind, cluster: connected[0] ?? "" } })} disabled={!connected.length || kind === "Event"}>
            <Plus aria-hidden />
            Create…
          </Button>
          <IconButton aria-label="Reload" title="Lists again and restarts the watch" onClick={refresh}>
            <RefreshCw />
          </IconButton>
        </div>

        <div className={cn("flex h-11 shrink-0 items-center gap-2 border-b border-line pl-3.5 pr-3", BAR)}>
          <label className="flex h-7 w-[240px] shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-surface-panel pl-2 pr-1.5 text-fg-muted focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
            <Search className="size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">Filter {label}</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (query ? setQuery("") : e.currentTarget.blur())}
              placeholder="Filter name, namespace, label…"
              spellCheck={false}
              className="min-w-0 flex-1 border-0 bg-transparent text-cell text-fg outline-none placeholder:text-fg-muted"
            />
            <Kbd>/</Kbd>
          </label>
          {namespaced && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <FilterToken k="namespace" value={namespaces === null ? "any" : `${namespaces.size} selected`} active={namespaces !== null} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-[360px] overflow-y-auto">
                <DropdownMenuLabel>Namespaces{hideSystem ? " · system hidden" : ""}</DropdownMenuLabel>
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
          )}
          <div className="flex-1" />
          {hiddenWide > 0 && (
            <label className="flex items-center gap-2 text-meta text-fg-secondary">
              <Switch checked={wide} onCheckedChange={setWide} aria-label="Wide columns" />
              Wide <span className="text-fg-muted">(+{hiddenWide})</span>
            </label>
          )}
        </div>

        <ClusterStateBanners clusters={selectedClusters} counts={counts} noun={label.toLowerCase()} />
        {Object.entries(errors).map(([c, e]) => (
          <Banner key={c} tone="warning" className="shrink-0 rounded-none border-t border-line">
            <b className="font-semibold">{c}:</b> <span className="selectable font-mono">{e}</span>
          </Banner>
        ))}
        {limited.map((l) => (
          <Banner key={l.cluster} tone="warning" className="shrink-0 rounded-none border-t border-line">
            <b className="font-semibold">Limited by RBAC:</b> can’t list {label.toLowerCase()} in all namespaces on {l.cluster} → showing only <span className="font-mono">{l.shown}</span>
          </Banner>
        ))}

        <ResourceTable
          table={table}
          aria-label={label}
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
          fillMin={160}
          empty={
            loading && connected.length ? (
              <EmptyState title={`Reading ${label.toLowerCase()}…`} />
            ) : !connected.length ? (
              <EmptyState icon={<SearchX />} title="No connected cluster selected">
                Pick a connected cluster to list {label.toLowerCase()}.
              </EmptyState>
            ) : (
              <EmptyState icon={<SearchX />} title={`No ${label.toLowerCase()}${query ? " match" : ""}`}>
                {query ? "Clear the filter or pick more clusters." : "None exist in the selected clusters."}
              </EmptyState>
            )
          }
        />

        <div className={cn("flex h-7 shrink-0 items-center gap-3.5 border-t border-line px-3.5 text-meta text-fg-muted", BAR)}>
          <span>
            <span className="text-fg">{rows.length}</span> {label.toLowerCase()}
          </span>
          {truncated.length > 0 && (
            <span className="text-status-warning">First 20,000 per cluster on {truncated.map((l) => l.cluster).join(", ")}; listed every 30s</span>
          )}
          <div className="flex-1" />
          {autoHidden.length > 0 && <span className="truncate">{autoHidden.join(", ")} hidden at this width</span>}
          <span>
            Columns: API server table view ·{" "}
            {Object.values(modes).includes("poll") ? "listed every 30s (poll mode)" : "live (watch)"}
          </span>
        </div>
      </main>

      {inspectorOpen && selected && (
        <InspectorPanel label={`${kindName(kind)} inspector`} storageKey="generic" active={active}>
          <GenericInspector row={selected} kind={kind} columns={columns.map((c) => c.name)} actions={actionsFor(selected)} onClose={() => setInspectorOpen(false)} />
        </InspectorPanel>
      )}
    </div>
  );
}

function GenericInspector({ row, kind, columns, actions, onClose }: { row: Row; kind: string; columns: string[]; actions: ResourceAction[]; onClose: () => void }) {
  const ws = useWorkspace();
  const cluster = ws.clusterById(row.cluster);
  const [copied, setCopied] = useState(false);
  const isEvent = kind === "Event";
  const events = useEvents(row.cluster, row.namespace ?? "", kindName(kind), row.name, !isEvent);
  const labels = Object.entries(row.labels ?? {});
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-line px-3.5 pb-3 pt-3">
        <div className="flex items-center gap-1.5">
          <EnvironmentBadge env={row.env} />
          <span className="truncate font-mono text-ui font-semibold text-fg" title={row.name}>
            {row.name}
          </span>
          <IconButton
            aria-label={copied ? "Copied" : "Copy name"}
            className="size-[22px] [&_svg]:size-3.5"
            onClick={() =>
              void navigator.clipboard?.writeText(row.name).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              })
            }
          >
            {copied ? <Check className="text-status-healthy" /> : <Copy />}
          </IconButton>
          <div className="flex-1" />
          <IconButton aria-label="Close inspector" onClick={onClose}>
            <X />
          </IconButton>
        </div>
        <span className="truncate text-meta text-fg-muted">
          {kindName(kind)}
          {row.namespace ? ` · ${row.namespace}` : ""} · {row.cluster}
        </span>
        <div className="flex items-center gap-1.5">
          <Button onClick={() => ws.openView({ kind: "yaml", title: `YAML · ${row.name}`, cluster: row.cluster, params: { kind, namespace: row.namespace ?? "", name: row.name } })}>
            <Code aria-hidden />
            YAML
          </Button>
          <div className="flex-1" />
          {cluster && <ModifyMenuButton actions={actions} target={{ env: row.env, protected: cluster.protected, readOnly: cluster.readOnly }} cluster={row.cluster} />}
        </div>
      </div>
      <Tabs defaultValue="details" className="flex min-h-0 flex-1 flex-col">
        <TabsList aria-label="Sections" className="mt-1 gap-3 px-3.5 pt-1.5">
          <TabsTrigger value="details">Details</TabsTrigger>
          {!isEvent && (
            <TabsTrigger value="events">
              Events {events !== null && <TabCount>{events.length}</TabCount>}
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="details" className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
          <dl className="m-0 grid grid-cols-[minmax(90px,auto)_1fr] gap-x-3 gap-y-1.5 text-ui">
            {columns.map((c, i) => (
              <div key={c} className="contents">
                <dt className="text-fg-muted">{c}</dt>
                <dd className="selectable m-0 break-words font-mono text-meta text-fg">{row.cells[i] || "—"}</dd>
              </div>
            ))}
            <dt className="text-fg-muted">Created</dt>
            <dd className="m-0 font-mono text-meta">{row.created ? `${row.created} (${formatAge(row.ageSec)} ago)` : "—"}</dd>
          </dl>
          {labels.length > 0 && (
            <div className="mt-3 flex flex-col gap-1">
              <span className="section-label">Labels</span>
              <div className="flex flex-wrap gap-1">
                {labels.map(([k, v]) => (
                  <span key={k} className="selectable rounded border border-line px-1.5 py-0.5 font-mono text-meta text-fg-secondary">
                    {k}={v}
                  </span>
                ))}
              </div>
            </div>
          )}
        </TabsContent>
        {!isEvent && (
          <TabsContent value="events" className="min-h-0 flex-1 overflow-y-auto">
            {events === null ? (
              <EmptyState title="Reading events…" />
            ) : events.length ? (
              <EventsPanel events={events} />
            ) : (
              <EmptyState title="No recent events">The API server keeps events for about 1 hour by default.</EmptyState>
            )}
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
