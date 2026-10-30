import { useState, type ReactNode } from "react";
import { Activity, KeyRound, RefreshCw, Unplug } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import type { Cluster } from "@/data/types";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { connectionLabel } from "@/components/status/EnvironmentBadge";
import { cn } from "@/lib/cn";

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
  if (!loading && !stale.length && !offline.length && !noMetrics.length) return null;

  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-3 py-2">
      {loading && (
        <div className="flex flex-wrap items-center gap-1.5" role="status" aria-label="Loading per cluster">
          {clusters
            .filter((c) => !isOffline(c))
            .map((c) => (
              <span
                key={c.id}
                className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line-strong px-2 text-ui"
              >
                <StatusGlyph health={c.connection === "connecting" ? "progressing" : "completed"} className={c.connection === "connecting" ? undefined : "text-status-healthy"} />
                <span className="font-mono">{c.name}</span>
                <span className="text-fg-muted">{c.connection === "connecting" ? "listing…" : counts[c.id] ?? 0}</span>
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
              <RefreshCw aria-hidden />
              Now
            </Button>
          }
        >
          <span className="font-mono">{c.name}</span> watch lost · retry {c.stale?.attempt ?? 1} in {c.stale?.nextRetrySec ?? 0}s ·
          showing data from {c.stale ? Math.round((Date.now() - c.stale.since) / 1000) : 0}s ago
        </Banner>
      ))}
      {offline.length > 0 && (
        <Banner tone="warning">
          Results are incomplete: showing {noun} from {clusters.length - offline.length} of {clusters.length} selected
          clusters.{" "}
          {offline.map((c, i) => (
            <span key={c.id}>
              {i > 0 && " · "}
              <span className="font-mono">{c.name}</span> {connectionLabel[c.connection].toLowerCase()}{" "}
              <button
                type="button"
                onClick={() => ws.connectCluster(c.id)}
                className="focus-ring rounded-sm border-0 bg-transparent p-0 text-ui text-accent hover:text-fg"
              >
                {c.connection === "auth-expired" ? "Retry after login" : c.connection === "unreachable" ? "Retry" : "Connect"}
              </button>
            </span>
          ))}
        </Banner>
      )}
      {noMetrics.length > 0 && (
        <Banner tone="info">
          No usage data on <span className="font-mono">{noMetrics.map((c) => c.name).join(", ")}</span>: the{" "}
          <span className="font-mono">metrics.k8s.io</span> API isn’t available. Requests and limits are still shown.
        </Banner>
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
          <span className="font-mono">{cluster.name}</span>{" "}
          {cluster.connection === "unreachable"
            ? "is unreachable"
            : cluster.connection === "auth-expired"
              ? "needs new credentials"
              : "is not connected"}
        </b>
      </div>
      {cluster.error && <span className="selectable font-mono text-meta text-fg-secondary">{cluster.error}</span>}
      {cluster.authHint && (
        <span className="text-cell text-fg-secondary">
          Run <span className="selectable font-mono text-ui text-fg">{cluster.authHint.command}</span> in your terminal, then
          retry. Clustrail never stores credentials.
        </span>
      )}
      <span className="text-cell text-fg-secondary">
        {cluster.lastConnected ? `Last connected ${cluster.lastConnected}. ` : ""}Nothing is cached for it, so it has no rows
        here; other selected clusters are unaffected.
      </span>
      <div className="flex gap-1.5">
        <Button size="sm" variant="primary" onClick={() => connectCluster(cluster.id)}>
          <RefreshCw aria-hidden />
          {cluster.connection === "disconnected" ? "Connect" : "Retry"}
        </Button>
        {onRemove && (
          <Button size="sm" onClick={onRemove}>
            Remove from selection
          </Button>
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
          {open ? "Hide" : "Details"}
        </Button>
      }
    >
      <b className="font-semibold">Limited by RBAC:</b>{" "}
      {rows.map((f, i) => (
        <span key={f.cluster}>
          {i > 0 && " · "}
          <span className="font-mono">{f.user || "this identity"}</span> can’t list {f.resource} in {f.namespace === "cluster" ? "this cluster" : "all namespaces"} on{" "}
          {f.cluster}
          {f.shown ? (
            <>
              {" "}→ showing only <span className="font-mono">{f.shown}</span>
            </>
          ) : (
            " → none listed"
          )}
        </span>
      ))}
      {open && (
        <span className="selectable mt-1 block font-mono text-meta text-fg-secondary">
          kubectl --context {first.cluster} auth can-i list {resource}
          {scope}
        </span>
      )}
    </Banner>
  );
}
