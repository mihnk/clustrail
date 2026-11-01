import { type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { backend } from "@/backend/client";
import { IconButton } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/cn";
import { t as tt } from "@/i18n";
import { useQueries } from "@/lib/useQuery";

export const BAR = "bg-surface-panel dark:bg-transparent";

/** The selected clusters that are connected, as ids. */
export function useConnectedClusters(): string[] {
  const { selectedClusters } = useWorkspace();
  return selectedClusters.filter((c) => c.connection === "connected").map((c) => c.id);
}

/**
 * Reads something per connected cluster while the tab is active, again every
 * `everyMs` (0: only on demand). Errors stay per cluster.
 */
export function usePerCluster<T>(name: string, load: (cluster: string) => Promise<T>, key: string, active: boolean, everyMs: number) {
  const clusters = useConnectedClusters();
  const entries: [string, string][] = backend ? clusters.map((c) => [c, `${name}|${c}|${key}`]) : [];
  const { states, refresh } = useQueries(entries, load, { every: everyMs, keepPrevious: true }, active);
  // Clusters no longer selected drop out of the result; a failed read keeps what was read before.
  const data: Record<string, T> = {};
  const errors: Record<string, string> = {};
  let loading = false;
  for (const c of clusters) {
    const s = states[c];
    if (!s) continue;
    if (s.data !== undefined) data[c] = s.data;
    if (s.error) errors[c] = s.error;
    loading ||= s.loading;
  }
  return { clusters, data, errors, loading, refresh };
}

export function Header({ icon, title, sub, children, onRefresh, loading }: { icon: ReactNode; title: string; sub?: ReactNode; children?: ReactNode; onRefresh?: () => void; loading?: boolean }) {
  return (
    <div className={cn("flex h-12 shrink-0 items-center gap-2.5 border-b border-line pl-3.5 pr-3", BAR)}>
      <span className="text-fg-secondary [&_svg]:size-4">{icon}</span>
      <span className="text-title font-semibold">{title}</span>
      {sub && <span className="truncate text-meta text-fg-muted">{sub}</span>}
      <div className="flex-1" />
      {children}
      {onRefresh && (
        <IconButton aria-label={tt("Reload")} onClick={onRefresh} className={cn(loading && "[&_svg]:animate-spin")}>
          <RefreshCw />
        </IconButton>
      )}
    </div>
  );
}

/** Browser preview and no connected cluster. */
export function NeedsClusters({ icon, title, clusters }: { icon: ReactNode; title: string; clusters: string[] }): ReactNode {
  if (!backend) {
    return (
      <EmptyState className="flex-1" icon={icon} title={title}>
        {tt("This check reads your clusters’ API servers, so it needs the desktop app.")}
      </EmptyState>
    );
  }
  if (!clusters.length) {
    return (
      <EmptyState className="flex-1" icon={icon} title={title}>
        {tt("Select a connected cluster in the sidebar.")}
      </EmptyState>
    );
  }
  return null;
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Event kinds to the keys resource tabs and lists use. */
export function kindKeyOf(kind: string): string {
  const groups: Record<string, string> = {
    Deployment: "apps",
    StatefulSet: "apps",
    DaemonSet: "apps",
    ReplicaSet: "apps",
    Job: "batch",
    CronJob: "batch",
    HorizontalPodAutoscaler: "autoscaling",
    Ingress: "networking.k8s.io",
    PodDisruptionBudget: "policy",
    Certificate: "cert-manager.io",
  };
  return groups[kind] ? `${groups[kind]}/${kind}` : kind;
}

/** Warning events of the last 15 minutes across the connected selected clusters, for the sidebar. Read every minute while the window is visible. */
export function useWarningCount(): number | null {
  const clusters = useConnectedClusters();
  const entries: [string, string][] = backend ? clusters.map((c) => [c, `warningCount|${c}|900`]) : [];
  const { states } = useQueries(entries, (c) => backend!.warningCount(c, 900), { every: 60_000, keepPrevious: true, retries: 0 });
  if (!backend || !clusters.length) return null;
  return clusters.reduce((sum, c) => sum + (states[c]?.data ?? 0), 0);
}
