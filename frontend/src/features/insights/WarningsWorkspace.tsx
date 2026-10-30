import { useDeferredValue, useMemo, useState } from "react";
import { Search, TriangleAlert } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { backend, type WarningEvent } from "@/backend/client";
import { Banner } from "@/components/ui/banner";
import { Segmented } from "@/components/ui/segmented";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { EmptyState } from "@/components/EmptyState";
import { resourceTab } from "@/features/resources/kinds";
import { cn } from "@/lib/cn";
import { ago, BAR, Header, kindKeyOf, NeedsClusters, usePerCluster } from "./shared";
import { t as tt } from "@/i18n";

const WINDOWS = { "15m": 900, "1h": 3600, all: 0 } as const;
type Window = keyof typeof WINDOWS;

interface Row extends WarningEvent {
  cluster: string;
  id: string;
}

/**
 * Warning events across the selected clusters, newest first: what broke in the
 * last minutes, without opening each object. Read again every 20 seconds.
 */
export function WarningsWorkspace({ active }: { active: boolean }) {
  const ws = useWorkspace();
  const [window, setWindow] = useState<Window>("1h");
  const [query, setQuery] = useState("");
  const [reason, setReason] = useState<string | null>(null);
  const deferred = useDeferredValue(query);
  const { clusters, data, errors, loading, refresh } = usePerCluster((c) => backend!.clusterWarnings(c, WINDOWS[window]), window, active, 20_000);

  const rows = useMemo<Row[]>(
    () =>
      Object.entries(data)
        .flatMap(([cluster, l]) => l.events.map((e, i) => ({ ...e, cluster, id: `${cluster}/${i}/${e.namespace}/${e.name}/${e.reason}` })))
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
    [data],
  );
  const reasons = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.reason, (m.get(r.reason) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [rows]);
  const shown = useMemo(() => {
    const words = deferred.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(
      (r) =>
        (!reason || r.reason === reason) &&
        words.every((w) => `${r.cluster} ${r.namespace ?? ""} ${r.kind} ${r.name} ${r.reason} ${r.message}`.toLowerCase().includes(w)),
    );
  }, [rows, reason, deferred]);
  const scoped = Object.values(data).filter((l) => l.scope);

  const empty = NeedsClusters({ icon: <TriangleAlert />, title: tt("Warning events"), clusters });
  if (empty) return empty;

  const open = (r: Row) => {
    if (r.kind === "Pod") {
      ws.openView({ kind: "pods", title: tt("Pods") });
      ws.revealResource("pod", `${r.cluster}/${r.namespace}/${r.name}`);
    } else if (r.kind === "Node") {
      ws.openView({ kind: "nodes", title: tt("Nodes") });
      ws.revealResource("node", `${r.cluster}/${r.name}`);
    } else {
      ws.openView(resourceTab(r.cluster, kindKeyOf(r.kind), r.namespace ?? "", r.name));
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-app">
      <Header icon={<TriangleAlert />} title={tt("Warning events")} sub={tt("{n} in {c} clusters", { n: rows.length, c: clusters.length })} onRefresh={refresh} loading={loading}>
        <Segmented
          aria-label={tt("Time window")}
          value={window}
          onValueChange={setWindow}
          options={[
            { value: "15m", label: "15m" },
            { value: "1h", label: "1h" },
            { value: "all", label: tt("All kept") },
          ]}
        />
      </Header>
      <div className={cn("flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-line py-2 pl-3.5 pr-3", BAR)}>
        <label className="flex h-7 w-[260px] shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-surface-panel pl-2 pr-1.5 text-fg-muted focus-within:border-accent">
          <Search className="size-3.5 shrink-0" aria-hidden />
          <span className="sr-only">{tt("Filter warnings")}</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tt("Filter object, reason, message…")}
            spellCheck={false}
            className="min-w-0 flex-1 border-0 bg-transparent text-cell text-fg outline-none placeholder:text-fg-muted"
          />
        </label>
        {reasons.map(([r, n]) => (
          <button
            key={r}
            type="button"
            aria-pressed={reason === r}
            onClick={() => setReason(reason === r ? null : r)}
            className={cn(
              "focus-ring flex h-6 items-center gap-1.5 rounded-full border px-2 text-meta",
              reason === r ? "border-line-selected bg-accent-soft text-fg" : "border-line-strong text-fg-secondary",
            )}
          >
            <span className="font-mono">{r}</span>
            <span className="text-fg-muted">{n}</span>
          </button>
        ))}
      </div>
      {Object.entries(errors).map(([c, e]) => (
        <Banner key={c} tone="warning" title={c} className="mx-3.5 mt-2.5">
          {e}
        </Banner>
      ))}
      {scoped.map((l) => (
        <Banner key={l.cluster} tone="info" title={l.cluster} className="mx-3.5 mt-2.5">
          {tt("Only namespace {ns}: listing events cluster-wide is not allowed for this identity.", { ns: l.scope })}
        </Banner>
      ))}
      {shown.length === 0 ? (
        <EmptyState className="flex-1" icon={<StatusGlyph health="healthy" />} title={rows.length ? tt("No warnings match the filter") : tt("No Warning events")}>
          {rows.length ? undefined : tt("The API server keeps events for about 1 hour by default.")}
        </EmptyState>
      ) : (
        <div role="list" aria-label={tt("Warning events")} className="min-h-0 flex-1 overflow-y-auto">
          {shown.slice(0, 1000).map((r) => {
            const env = ws.clusterById(r.cluster)?.env ?? "dev";
            return (
              <button
                key={r.id}
                type="button"
                role="listitem"
                onClick={() => open(r)}
                className="focus-ring flex w-full items-start gap-3 border-b border-line-row px-3.5 py-2 text-left hover:bg-surface-hover"
              >
                <span className="w-9 shrink-0 pt-px text-right font-mono text-meta text-fg-muted" title={r.lastSeen}>
                  {ago(r.lastSeen)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5 text-ui">
                    <EnvironmentBadge env={env} />
                    <span className="shrink-0 font-mono font-semibold text-status-warning">{r.reason}</span>
                    <span className="min-w-0 truncate font-mono text-fg">
                      {r.kind.toLowerCase()}/{r.name}
                    </span>
                    <span className="shrink-0 text-meta text-fg-muted">
                      {r.namespace ? `${r.namespace} · ` : ""}
                      {r.cluster}
                    </span>
                    {r.count > 1 && <span className="ml-auto shrink-0 rounded bg-status-warning-soft px-1.5 font-mono text-meta text-status-warning">×{r.count}</span>}
                  </span>
                  <span className="selectable line-clamp-2 text-meta text-fg-secondary">{r.message}</span>
                </span>
              </button>
            );
          })}
          {shown.length > 1000 && <div className="px-3.5 py-2 text-meta text-fg-muted">{tt("Showing the newest 1,000 of {n}. Narrow the filter to see others.", { n: shown.length })}</div>}
        </div>
      )}
    </main>
  );
}
