import { Lock } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { IS_MOCK, getAccessSummary } from "@/data/mock";
import { ConnectionDot } from "@/components/status/EnvironmentBadge";

export function StatusBar() {
  const { clusters, selectedClusters, activeTab, clusterById } = useWorkspace();
  const investigating = activeTab?.kind === "investigation";
  const scoped = activeTab?.cluster ? clusterById(activeTab.cluster) : undefined;

  if (scoped) {
    // Single-cluster workspace: its connection and what this kubeconfig user may do here.
    const access = getAccessSummary(scoped.id, "payments", "deployments", "patch");
    return (
      <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-surface-side px-3 text-meta text-fg-muted">
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <ConnectionDot state={scoped.connection} />
          <span className="text-fg-secondary">
            {scoped.name} {scoped.connection === "connected" ? `connected · ${scoped.latencyMs}ms` : "not connected"}
          </span>
        </span>
        <span className="truncate">
          RBAC: <span className="font-mono">{access.user}</span> {access.allowed ? "can" : "cannot"} {access.verb}{" "}
          {access.resource} in {access.namespace}
        </span>
        <div className="flex-1" />
        {scoped.protected && (
          <span className="flex items-center gap-1.5 whitespace-nowrap text-env-prod-ink">
            <Lock className="size-3" aria-hidden />
            Protected
          </span>
        )}
        {IS_MOCK && (
          <span className="rounded border border-line-strong px-1.5 py-0.5 font-mono text-2xs tracking-[.06em]">MOCK DATA</span>
        )}
      </footer>
    );
  }
  const connected = selectedClusters.filter((c) => c.connection === "connected");
  const expired = clusters.filter((c) => c.connection === "auth-expired").length;
  const protectedCount = selectedClusters.filter((c) => c.protected).length;
  const allConnected = connected.length === selectedClusters.length;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-surface-side px-3 text-meta text-fg-muted">
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <ConnectionDot state={allConnected ? "connected" : "reconnecting"} />
        <span className="text-fg-secondary">
          {connected.length}/{selectedClusters.length} selected connected
        </span>
      </span>
      {investigating ? (
        // Investigations keep their own watches on the involved objects.
        <span className="whitespace-nowrap">Watching 12 objects · live</span>
      ) : (
        <span className="truncate font-mono text-label">
          {connected.map((c) => `${c.name} ${c.latencyMs}ms`).join(" · ")}
        </span>
      )}
      {expired > 0 && (
        <span className="whitespace-nowrap text-status-warning">
          {expired} {expired === 1 ? "credential" : "credentials"} expired
        </span>
      )}
      <div className="flex-1" />
      {protectedCount > 0 && (
        <span className="flex items-center gap-1.5 whitespace-nowrap text-env-prod-ink">
          <Lock className="size-3" aria-hidden />
          {protectedCount} production {protectedCount === 1 ? "cluster" : "clusters"} protected
        </span>
      )}
      {!investigating && <span className="whitespace-nowrap">Metrics: metrics-server</span>}
      {IS_MOCK && (
        <span className="rounded border border-line-strong px-1.5 py-0.5 font-mono text-2xs tracking-[.06em]">MOCK DATA</span>
      )}
    </footer>
  );
}
