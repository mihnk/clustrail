import { useState, type ReactNode } from "react";
import { Activity, KeyRound, RefreshCw, Unplug } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import type { Cluster } from "@/data/types";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { connectionLabel } from "@/components/status/EnvironmentBadge";
import { cn } from "@/lib/cn";
import { ago, locale, t, tn } from "@/i18n";

const OFFLINE = new Set(["disconnected", "auth-expired", "unreachable"]);

export function isOffline(c: Cluster) {
  return OFFLINE.has(c.connection);
}

/**
 * Per-cluster state above an explorer's table: progressive loading, stale
 * data while a watch reconnects, clusters that are not connected, and missing
 * metrics. Each state is reported once per view, never per row.
 */
export function ClusterStateBanners({
  clusters,
  counts,
  noun,
}: {
  clusters: Cluster[];
  /** Rows per cluster, for the loading chips. */
  counts: Record<string, number>;
  noun: string;
}) {
  const ws = useWorkspace();
  const loading = clusters.some((c) => c.connection === "connecting");
  const stale = clusters.filter((c) => c.connection === "reconnecting");
  const offline = clusters.filter(isOffline);
  const noMetrics = clusters.filter((c) => c.connection === "connected" && c.metrics === null);
  const paused = clusters.filter((c) => c.paused);
  if (!loading && !stale.length && !offline.length && !noMetrics.length && !paused.length) return null;

  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-3 py-2">
      {paused.length > 0 && (
        <Banner tone="info">
          <b className="font-semibold">{t("Paused in the background:")}</b> {paused.map((c) => c.name).join(", ")}{" "}{t("· reconnecting with a full re-list")}</Banner>
      )}
      {loading && (
        <div className="flex flex-wrap items-center gap-1.5" role="status" aria-label={t("Loading per cluster")}>
          {clusters
            .filter((c) => !isOffline(c))
            .map((c) => (
              <span
                key={c.id}
                className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line-strong px-2 text-ui"
              >
                <StatusGlyph health={c.connection === "connecting" ? "progressing" : "completed"} className={c.connection === "connecting" ? undefined : "text-status-healthy"} />
                <span className="font-mono">{c.name}</span>
                <span className="text-fg-muted">{c.connection === "connecting" ? t("listing…") : counts[c.id] ?? 0}</span>
              </span>
            ))}
        </div>
      )}
      {stale.map((c) => (
        <Banner
          key={c.id}
          tone="warning"
          action={
            <Button size="sm" variant="ghost" onClick={() => ws.setScenario("watchLost", false)}>
              <RefreshCw aria-hidden />{t("Now")}</Button>
          }
        >
          {tn("{name} watch lost · retry {attempt} in {next}s · showing data from {age}s ago", {
            name: <span className="font-mono">{c.name}</span>,
            attempt: c.stale?.attempt ?? 1,
            next: c.stale?.nextRetrySec ?? 0,
            age: c.stale ? Math.round((Date.now() - c.stale.since) / 1000) : 0,
          })}
        </Banner>
      ))}
      {offline.length > 0 && (
        <Banner tone="warning">
          {t("Results are incomplete: showing {noun} from {shown} of {total} selected clusters.", { noun: t(noun), shown: clusters.length - offline.length, total: clusters.length })}{" "}
          {offline.map((c, i) => (
            <span key={c.id}>
              {i > 0 && " · "}
              <span className="font-mono">{c.name}</span> {t(connectionLabel[c.connection]).toLocaleLowerCase(locale())}{" "}
              <button
                type="button"
                onClick={() => ws.connectCluster(c.id)}
                className="focus-ring rounded-sm border-0 bg-transparent p-0 text-ui text-accent hover:text-fg"
              >
                {c.connection === "auth-expired" ? t("Retry after login") : c.connection === "unreachable" ? t("Retry") : t("Connect")}
              </button>
            </span>
          ))}
        </Banner>
      )}
      {noMetrics.length > 0 && (
        <Banner tone="info">{tn("No usage data on {v0}: the {v1} API isn’t available. Requests and limits are still shown.", { v0: <span className="font-mono">{noMetrics.map((c) => c.name).join(", ")}</span>, v1: <span className="font-mono">metrics.k8s.io</span> })}</Banner>
      )}
    </div>
  );
}

/** Card for a cluster that cannot provide data, with one fix action. */
export function DisconnectedCluster({ cluster, onRemove }: { cluster: Cluster; onRemove?: () => void }) {
  const { connectCluster } = useWorkspace();
  const icon: Record<string, ReactNode> = {
    unreachable: <Unplug className="size-4 text-status-critical" aria-hidden />,
    "auth-expired": <KeyRound className="size-4 text-status-warning" aria-hidden />,
  };
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-line-strong p-3.5">
      <div className="flex items-center gap-2 text-cell">
        {icon[cluster.connection] ?? <Activity className="size-4 text-fg-muted" aria-hidden />}
        <b className="font-semibold">
          {tn(
            cluster.connection === "unreachable"
              ? "{name} is unreachable"
              : cluster.connection === "auth-expired"
                ? "{name} needs new credentials"
                : "{name} is not connected",
            { name: <span className="font-mono">{cluster.name}</span> },
          )}
        </b>
      </div>
      {cluster.error && <span className="selectable font-mono text-meta text-fg-secondary">{cluster.error}</span>}
      {cluster.authHint && (
        <span className="text-cell text-fg-secondary">{tn("Run {command} in your terminal, then retry. Clustrail never stores credentials.", { command: <span className="selectable font-mono text-ui text-fg">{cluster.authHint.command}</span> })}</span>
      )}
      <span className="text-cell text-fg-secondary">
        {cluster.lastConnected ? t("Last connected {lastConnected}. ", { lastConnected: ago(cluster.lastConnected) }) : ""}{t("Nothing is cached for it, so it has no rows here; other selected clusters are unaffected.")}</span>
      <div className="flex gap-1.5">
        <Button size="sm" variant="primary" onClick={() => connectCluster(cluster.id)}>
          <RefreshCw aria-hidden />
          {cluster.connection === "disconnected" ? t("Connect") : t("Retry")}
        </Button>
        {onRemove && (
          <Button size="sm" onClick={onRemove}>{t("Remove from selection")}</Button>
        )}
      </div>
    </div>
  );
}

/** Static placeholder rows for clusters still listing (no shimmer). */
export function SkeletonRows({ count, rowHeight }: { count: number; rowHeight: number }) {
  const widths = ["70%", "55%", "62%", "48%"];
  return (
    <div aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="grid grid-cols-[96px_minmax(0,1fr)_96px_36px] items-center gap-x-2 border-b border-line-row px-3"
          style={{ height: rowHeight }}
        >
          <span className="block h-2 w-14 rounded bg-line" />
          <span className="block h-2 rounded bg-line" style={{ width: widths[i % widths.length] }} />
          <span className="block h-2 w-16 rounded bg-line" />
          <span className={cn("block h-2 w-6 justify-self-end rounded bg-line")} />
        </div>
      ))}
    </div>
  );
}

/**
 * What RBAC kept out of this list (desktop): resources this identity cannot
 * list cluster-wide, and the one namespace shown instead when that is allowed.
 */
export function RbacBanner({ clusters, resource }: { clusters: string[]; resource: string }) {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const rows = (ws.backendMeta?.forbidden ?? []).filter((f) => clusters.includes(f.cluster) && f.resource === resource);
  if (!rows.length) return null;
  const first = rows[0]!;
  const scope = first.namespace === "cluster" ? "" : first.shown ? ` -n ${first.shown}` : " -A";
  return (
    <Banner
      tone="warning"
      className="shrink-0 rounded-none border-t border-line"
      action={
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          {open ? t("Hide") : t("Details")}
        </Button>
      }
    >
      <b className="font-semibold">{t("Limited by RBAC:")}</b>{" "}
      {rows.map((f, i) => (
        <span key={f.cluster}>
          {i > 0 && " · "}
          {tn(f.namespace === "cluster" ? "{user} can’t list {resource} in this cluster on {cluster}" : "{user} can’t list {resource} in all namespaces on {cluster}", {
            user: <span className="font-mono">{f.user || t("this identity")}</span>,
            resource: f.resource,
            cluster: f.cluster,
          })}
          {f.shown ? <> {tn("→ showing only {namespace}", { namespace: <span className="font-mono">{f.shown}</span> })}</> : ` ${t("→ none listed")}`}
        </span>
      ))}
      {open && (
        <span className="selectable mt-1 block font-mono text-meta text-fg-secondary">{t("kubectl --context {cluster} auth can-i list {resource}{scope}", { cluster: first.cluster, resource, scope })}
        </span>
      )}
    </Banner>
  );
}
