import { Lock } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { IS_MOCK } from "@/data/mock";
import { ConnectionDot } from "@/components/status/EnvironmentBadge";

export function StatusBar() {
  const { selectedClusters } = useWorkspace();
  const connected = selectedClusters.filter((c) => c.connection === "connected");
  const protectedCount = selectedClusters.filter((c) => c.protected).length;
  const allConnected = connected.length === selectedClusters.length;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-surface-side px-3 text-meta text-fg-muted">
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <ConnectionDot state={allConnected ? "connected" : "reconnecting"} />
        <span className="text-fg-secondary">
          {connected.length}/{selectedClusters.length} connected
        </span>
      </span>
      <span className="truncate font-mono text-label">
        {connected.map((c) => `${c.name} ${c.latencyMs}ms`).join(" · ")}
      </span>
      <div className="flex-1" />
      {protectedCount > 0 && (
        <span className="flex items-center gap-1.5 whitespace-nowrap text-env-prod-ink">
          <Lock className="size-3" aria-hidden />
          {protectedCount} production {protectedCount === 1 ? "cluster" : "clusters"} protected
        </span>
      )}
      <span className="whitespace-nowrap">Metrics: metrics-server</span>
      {IS_MOCK && (
        <span className="rounded border border-line-strong px-1.5 py-0.5 font-mono text-2xs tracking-[.06em]">MOCK DATA</span>
      )}
    </footer>
  );
}
