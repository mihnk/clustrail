import { PortForwardIndicator } from "@/features/portforward/PortForward";
import { Lock } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { IS_MOCK, getAccessSummary } from "@/data/mock";
import { ConnectionDot } from "@/components/status/EnvironmentBadge";
import { t, tn } from "@/i18n";

export function StatusBar() {
  const { clusters, selectedClusters, activeTab, clusterById, jobs, pins } = useWorkspace();
  const job = jobs[0];
  const jobItem = job ? (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-status-progressing" role="status">
      <span className="size-1.5 rounded-full bg-status-progressing" />
      {job.title} · {job.detail.split(" · ")[0]}
    </span>
  ) : null;
  const investigating = activeTab?.kind === "investigation";
  const scoped = activeTab?.cluster ? clusterById(activeTab.cluster) : undefined;

  if (scoped) {
    // Single-cluster workspace: its connection and what this kubeconfig user may do here.
    const access = getAccessSummary(scoped.id, "payments", "deployments", "patch");
    const note =
      activeTab?.kind === "logs"
        ? "Read-only stream · protected mode does not apply to logs"
        : activeTab?.kind === "shell"
          ? "Shell commands are not checked by Clustrail · RBAC: pods/exec"
          : activeTab?.kind === "yaml"
            ? "Edits apply with server-side apply · protected mode asks first"
            : null;
    return (
      <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-surface-side px-3 text-meta text-fg-muted">
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <ConnectionDot state={scoped.connection} />
          <span className="text-fg-secondary">
            {scoped.name} {scoped.connection === "connected" ? t("connected · {latencyMs}ms", { latencyMs: scoped.latencyMs }) : t("not connected")}
          </span>
        </span>
        {note ? (
          <span className="truncate">{t(note)}</span>
        ) : IS_MOCK ? (
          <span className="truncate">
            {tn(access.allowed ? "RBAC: {user} can {verb} {resource} in {namespace}" : "RBAC: {user} cannot {verb} {resource} in {namespace}", {
              user: <span className="font-mono">{access.user}</span>,
              verb: access.verb,
              resource: access.resource,
              namespace: access.namespace,
            })}
          </span>
        ) : scoped.identity ? (
          <span className="truncate">{t("RBAC identity")}{" "}<span className="font-mono">{scoped.identity}</span>
          </span>
        ) : null}
        <div className="flex-1" />
        <PortForwardIndicator />
        {scoped.protected && (
          <span className="flex items-center gap-1.5 whitespace-nowrap text-env-prod-ink">
            <Lock className="size-3" aria-hidden />{t("Protected")}</span>
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
          {t("{nConnected}/{nSelectedClusters} selected connected", { nConnected: connected.length, nSelectedClusters: selectedClusters.length })}</span>
      </span>
      {investigating ? (
        // Investigations keep their own watches on the involved objects.
        <span className="whitespace-nowrap">
          {IS_MOCK ? t("Watching 12 objects · live") : t("{length} pinned · saved locally", { length: pins.length })}
        </span>
      ) : (
        <span className="truncate font-mono text-label max-[1360px]:hidden">
          {connected.map((c) => `${c.name} ${c.latencyMs}ms`).join(" · ")}
        </span>
      )}
      {jobItem}
      {expired > 0 && (
        <span className="whitespace-nowrap text-status-warning">
          {t(expired === 1 ? "{n} credential expired" : "{n} credentials expired", { n: expired })}</span>
      )}
      <div className="flex-1" />
      <PortForwardIndicator />
      {protectedCount > 0 && (
        <span data-tour="protected" className="flex items-center gap-1.5 whitespace-nowrap text-env-prod-ink">
          <Lock className="size-3" aria-hidden />
          {t(protectedCount === 1 ? "{n} production cluster protected" : "{n} production clusters protected", { n: protectedCount })}</span>
      )}
      {!investigating && <span className="whitespace-nowrap">{t("Metrics: metrics-server")}</span>}
      {IS_MOCK && (
        <span className="rounded border border-line-strong px-1.5 py-0.5 font-mono text-2xs tracking-[.06em]">MOCK DATA</span>
      )}
    </footer>
  );
}
