import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { backend, errorText } from "@/backend/client";
import { IconButton } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/cn";
import { t as tt } from "@/i18n";

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
export function usePerCluster<T>(load: (cluster: string) => Promise<T>, key: string, active: boolean, everyMs: number) {
  const clusters = useConnectedClusters();
  const [data, setData] = useState<Record<string, T>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const clustersKey = clusters.join(",");

  useEffect(() => {
    if (!backend || !active || !clusters.length) return;
    let cancelled = false;
    const run = () => {
      setLoading(true);
      void Promise.all(
        clusters.map((c) =>
          loadRef
            .current(c)
            .then((v) => {
              if (cancelled) return;
              setData((d) => ({ ...d, [c]: v }));
              setErrors((e) => {
                if (!(c in e)) return e;
                const next = { ...e };
                delete next[c];
                return next;
              });
            })
            .catch((err) => !cancelled && setErrors((e) => ({ ...e, [c]: errorText(err) }))),
        ),
      ).finally(() => !cancelled && setLoading(false));
    };
    run();
    const t = everyMs > 0 ? setInterval(run, everyMs) : undefined;
    return () => {
      cancelled = true;
      if (t) clearInterval(t);
    };
  }, [clustersKey, key, active, tick, everyMs]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  // Clusters no longer selected drop out of the result.
  const current: Record<string, T> = {};
  for (const c of clusters) if (data[c] !== undefined) current[c] = data[c]!;
  return { clusters, data: current, errors, loading, refresh };
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
  const [counts, setCounts] = useState<Record<string, number>>({});
  const key = clusters.join(",");
  useEffect(() => {
    if (!backend || !clusters.length) return;
    let cancelled = false;
    const run = () => {
      if (document.visibilityState !== "visible") return;
      for (const c of clusters) {
        backend!
          .warningCount(c, 900)
          .then((n) => !cancelled && setCounts((m) => (m[c] === n ? m : { ...m, [c]: n })))
          .catch(() => {});
      }
    };
    run();
    const t = setInterval(run, 60_000);
    document.addEventListener("visibilitychange", run);
    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", run);
    };
  }, [key]);
  if (!backend || !clusters.length) return null;
  return clusters.reduce((sum, c) => sum + (counts[c] ?? 0), 0);
}
