import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { getCoreRowModel, getSortedRowModel, useReactTable, type SortingState } from "@tanstack/react-table";
import { Check, Copy, GitBranch, RefreshCw, RotateCw, Search, SearchX } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { ROW_HEIGHT } from "@/app/preferences";
import { isAttention } from "@/data/health";
import { controllers, type AppHealth, type GitOpsObject, type SyncState } from "@/data/gitops";
import { ResourceTable } from "@/components/resource-table/ResourceTable";
import type { ResourceAction } from "@/components/resource-actions/ResourceActions";
import { useConfirm, type ConfirmationRequest } from "@/components/safety/ConfirmationDialog";
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
import { EnvMarker } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { EmptyState } from "@/components/EmptyState";
import type { Cluster } from "@/data/types";
import { cn } from "@/lib/cn";
import { gitopsColumns } from "./columns";
import { GitOpsInspector } from "./GitOpsInspector";

const BAR = "bg-surface-panel dark:bg-transparent";

function syncRequest(o: GitOpsObject, cluster: Cluster | undefined, onConfirm: () => void): ConfirmationRequest {
  const argo = o.tool === "Argo CD";
  return {
    action: argo ? "Sync application" : "Reconcile with source",
    targetName: o.name,
    icon: <RotateCw />,
    env: o.env,
    cluster: o.cluster,
    namespace: o.namespace,
    meta: `${o.kind} → ${o.destination} · revision ${o.revision}`,
    protected: cluster?.protected ?? false,
    destructive: false,
    whatHappens: (
      <>
        {argo ? "Argo CD applies" : "Flux fetches the source and applies"} the desired state of <span className="font-mono">{o.revision}</span>.
        {o.drift.length > 0 && <> Live changes are overwritten: {o.drift.map((d) => `${d.field} ${d.live} → ${d.desired}`).join(", ")}.</>}
        {o.policy.prune && " Resources removed from git are pruned."}
      </>
    ),
    command: argo
      ? `argocd app sync ${o.name} --kube-context ${o.cluster}`
      : `flux reconcile ${o.kind.toLowerCase()} ${o.name} -n ${o.namespace} --with-source --context ${o.cluster}`,
    confirmLabel: argo ? "Sync" : "Reconcile",
    phrase: o.name,
    onConfirm,
  };
}

function refreshRequest(o: GitOpsObject, cluster: Cluster | undefined, onConfirm: () => void): ConfirmationRequest {
  const argo = o.tool === "Argo CD";
  return {
    action: argo ? "Refresh application" : "Request reconcile",
    targetName: o.name,
    icon: <RefreshCw />,
    env: o.env,
    cluster: o.cluster,
    namespace: o.namespace,
    protected: cluster?.protected ?? false,
    destructive: false,
    whatHappens: argo
      ? "Sets the argocd.argoproj.io/refresh annotation. Argo CD re-reads git and recomputes the diff; nothing is applied unless automated sync is on."
      : "Sets reconcile.fluxcd.io/requestedAt. Flux runs its normal reconcile now instead of at the next interval.",
    command: argo
      ? `kubectl --context ${o.cluster} -n ${o.namespace} annotate application ${o.name} argocd.argoproj.io/refresh=normal --overwrite`
      : `flux reconcile ${o.kind.toLowerCase()} ${o.name} -n ${o.namespace} --context ${o.cluster}`,
    confirmLabel: argo ? "Refresh" : "Reconcile",
    phrase: o.name,
    onConfirm,
  };
}

/** Argo CD Applications and Flux Kustomizations / HelmReleases across the selected clusters. */
export function GitOpsWorkspace({ active }: { active: boolean }) {
  const ws = useWorkspace();
  const { gitops, selectedClusterIds, clusterById, density, refreshGitOps, syncGitOps, setGitOpsSuspended } = ws;
  const { confirm } = useConfirm();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [tool, setTool] = useState<"all" | "argo" | "flux">("all");
  const [sync, setSync] = useState<"any" | SyncState>("any");
  const [appHealth, setAppHealth] = useState<"any" | AppHealth>("any");
  const [health, setHealth] = useState<"all" | "attention">("all");
  const [sorting, setSorting] = useState<SortingState>([{ id: "sync", desc: false }]);
  const [selectedId, setSelectedId] = useState<string | null>("prod-eu-west-1/Application/payments-gateway");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const inClusters = useMemo(() => gitops.filter((o) => selectedClusterIds.includes(o.cluster)), [gitops, selectedClusterIds]);
  const baseRows = useMemo(() => {
    const words = deferredQuery.toLowerCase().split(/\s+/).filter(Boolean);
    return inClusters.filter(
      (o) =>
        (tool === "all" || (tool === "argo" ? o.tool === "Argo CD" : o.tool === "Flux")) &&
        (sync === "any" || o.sync === sync) &&
        (appHealth === "any" || o.appHealth === appHealth) &&
        words.every((w) => `${o.name} ${o.kind} ${o.repo} ${o.path} ${o.revision}`.toLowerCase().includes(w)),
    );
  }, [inClusters, tool, sync, appHealth, deferredQuery]);
  const attention = baseRows.filter((o) => isAttention(o.health)).length;
  const rows = useMemo(() => (health === "attention" ? baseRows.filter((o) => isAttention(o.health)) : baseRows), [baseRows, health]);

  const table = useReactTable({
    data: rows,
    columns: gitopsColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (o) => o.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const requestSync = useCallback((o: GitOpsObject) => confirm(syncRequest(o, clusterById(o.cluster), () => syncGitOps(o.id))), [confirm, clusterById, syncGitOps]);
  // Refresh only re-reads git; it asks first only where Clustrail protection applies.
  const requestRefresh = useCallback(
    (o: GitOpsObject) => {
      const c = clusterById(o.cluster);
      if (c?.protected) confirm(refreshRequest(o, c, () => refreshGitOps(o.id)));
      else refreshGitOps(o.id);
    },
    [confirm, clusterById, refreshGitOps],
  );

  const actionsFor = useCallback(
    (o: GitOpsObject): ResourceAction[] => [
      { id: "refresh", group: "modify", label: o.tool === "Argo CD" ? "Refresh" : "Reconcile", icon: <RefreshCw />, onSelect: () => requestRefresh(o) },
      { id: "sync", group: "modify", label: o.tool === "Argo CD" ? "Sync…" : "Reconcile with source…", icon: <RotateCw />, disabled: o.suspended, onSelect: () => requestSync(o) },
    ],
    [requestRefresh, requestSync],
  );

  const rowActions = useCallback(
    (id: string) => {
      const o = rows.find((x) => x.id === id);
      const c = o ? clusterById(o.cluster) : undefined;
      return o && c ? { actions: actionsFor(o), target: { env: o.env, protected: c.protected, readOnly: c.readOnly } } : null;
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

  const selected = gitops.find((o) => o.id === selectedId) ?? null;
  const outOfSync = inClusters.filter((o) => o.sync === "OutOfSync").length;
  const failing = inClusters.filter((o) => o.health === "failed").length;
  const failure = rows.find((o) => o.error && o.kind === "Kustomization") ?? rows.find((o) => o.error);
  const argoCount = inClusters.filter((o) => o.tool === "Argo CD").length;
  const shownControllers = controllers.filter((c) => selectedClusterIds.includes(c.cluster) || c.tool === null);

  return (
    <div className="flex min-h-0 flex-1">
      <main className="@container flex min-w-0 flex-1 flex-col bg-surface-app">
        <div className={cn("flex h-12 shrink-0 items-center gap-2.5 border-b border-line pl-3.5 pr-3", BAR)}>
          <GitBranch className="size-4" aria-hidden />
          <span className="text-title font-semibold">GitOps</span>
          <div className="flex-1" />
          <Segmented
            aria-label="Kind"
            value={tool}
            onValueChange={setTool}
            options={[
              { value: "all", label: <>All <span className="font-mono text-fg-muted">{inClusters.length}</span></> },
              { value: "argo", label: <>Argo CD apps <span className="font-mono text-fg-muted">{argoCount}</span></> },
              { value: "flux", label: <>Flux <span className="font-mono text-fg-muted">{inClusters.length - argoCount}</span></> },
            ]}
          />
        </div>

        <div className={cn("flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-3.5 py-2 [scrollbar-width:none]", BAR)}>
          <span className="section-label pr-1">Controllers</span>
          {shownControllers.map((c) => (
            <span
              key={c.cluster}
              title={c.tool ? undefined : "Looked for applications.argoproj.io and kustomizations.kustomize.toolkit.fluxcd.io"}
              className={cn(
                "flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-line px-2 text-ui",
                !c.tool && "text-fg-muted max-[1360px]:hidden",
              )}
            >
              <EnvMarker env={c.env} />
              <span className="font-mono">{c.cluster}</span>
              {c.tool ? (
                <>
                  <StatusGlyph health="healthy" />
                  {c.tool} {c.version}
                </>
              ) : (
                "not detected"
              )}
            </span>
          ))}
        </div>

        <div className={cn("flex h-11 shrink-0 items-center gap-1.5 border-b border-line pl-3.5 pr-3", BAR)}>
          <label className="flex h-7 w-[200px] shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-surface-panel pl-2 pr-1.5 text-fg-muted focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
            <Search className="size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">Filter GitOps objects</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (query ? setQuery("") : e.currentTarget.blur())}
              placeholder="Filter name, repo, path…"
              spellCheck={false}
              className="min-w-0 flex-1 border-0 bg-transparent text-cell text-fg outline-none placeholder:text-fg-muted"
            />
            <Kbd>/</Kbd>
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FilterToken k="sync" value={sync} active={sync !== "any"} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Sync</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sync} onValueChange={(v) => setSync(v as typeof sync)}>
                {(["any", "Synced", "OutOfSync", "Applied", "Failed"] as const).map((s) => (
                  <DropdownMenuRadioItem key={s} value={s}>
                    {s}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FilterToken k="health" value={appHealth} active={appHealth !== "any"} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Health</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={appHealth} onValueChange={(v) => setAppHealth(v as typeof appHealth)}>
                {(["any", "Healthy", "Ready", "Progressing", "Degraded", "Not ready", "Suspended"] as const).map((s) => (
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
              { value: "all", label: "All" },
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

        <ResourceTable
          table={table}
          aria-label="GitOps objects"
          rowHeight={ROW_HEIGHT[density]}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setInspectorOpen(true);
          }}
          onOpen={() => setInspectorOpen(true)}
          onDismiss={() => setInspectorOpen(false)}
          rowActions={rowActions}
          fillMin={150}
          empty={
            <EmptyState icon={<SearchX />} title="No GitOps objects match">
              Clear the filters or pick more clusters.
            </EmptyState>
          }
        />

        {failure && (
          <div role="alert" className="flex shrink-0 items-start gap-2.5 border-t border-line bg-status-critical-soft px-3.5 py-2 text-cell">
            <StatusGlyph health="failed" className="mt-[3px]" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span>
                <b className="font-semibold">
                  {failure.kind} {failure.name}
                </b>{" "}
                <span className="text-fg-secondary">
                  · {failure.cluster} · {failure.conditions[0]?.type} · {failure.conditions[0]?.message} · {failure.conditions[0]?.at}
                </span>
              </span>
              <span className="selectable truncate font-mono text-ui text-fg-secondary" title={failure.error}>
                {failure.error}
              </span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void navigator.clipboard?.writeText(failure.error ?? "").then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                })
              }
            >
              {copied ? <Check className="text-status-healthy" aria-hidden /> : <Copy aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        )}

        <div className={cn("flex h-7 shrink-0 items-center gap-3.5 border-t border-line px-3.5 text-meta text-fg-muted", BAR)}>
          <span>
            <span className="text-fg">{rows.length}</span> objects
          </span>
          {outOfSync > 0 && <span className="text-status-warning">{outOfSync} OutOfSync</span>}
          {failing > 0 && <span className="text-status-critical">{failing} failing</span>}
          <div className="flex-1" />
          <span className="truncate max-[1360px]:hidden">Clustrail reads controller status; it never pushes to git</span>
        </div>
      </main>

      {inspectorOpen && selected && (
        <InspectorPanel label="Application inspector" storageKey="gitops" defaultWidth={400} active={active}>
          <GitOpsInspector
            object={selected}
            cluster={clusterById(selected.cluster)}
            controller={controllers.find((c) => c.cluster === selected.cluster)}
            onClose={() => setInspectorOpen(false)}
            onRefresh={() => requestRefresh(selected)}
            onSync={() => requestSync(selected)}
            onSuspend={(s) => setGitOpsSuspended(selected.id, s)}
            onOpenYaml={(r) =>
              ws.openView({ kind: "yaml", title: `YAML · ${r.name}`, cluster: selected.cluster, params: { kind: r.kind, namespace: selected.destination, name: r.name } })
            }
          />
        </InspectorPanel>
      )}
    </div>
  );
}
