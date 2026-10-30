import { useEffect, useState } from "react";
import { Code, ExternalLink, GitBranch, Layers, Lock, Pause, Play, RefreshCw, RotateCw, X } from "lucide-react";
import type { Cluster } from "@/data/types";
import type { Controller, GitOpsObject } from "@/data/gitops";
import { Button, IconButton } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabCount } from "@/components/ui/tabs";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { formatAge } from "@/lib/format";
import { cn } from "@/lib/cn";
import { AppHealthStatus, SyncStatus } from "./columns";

export function GitOpsInspector({
  object: o,
  cluster,
  controller,
  onClose,
  onRefresh,
  onSync,
  onSuspend,
  onOpenYaml,
}: {
  object: GitOpsObject;
  cluster: Cluster | undefined;
  controller: Controller | undefined;
  onClose: () => void;
  onRefresh: () => void;
  onSync: () => void;
  onSuspend: (suspended: boolean) => void;
  onOpenYaml: (resource: { kind: string; name: string }) => void;
}) {
  const [tab, setTab] = useState(o.drift.length ? "diff" : "overview");
  useEffect(() => setTab(o.drift.length ? "diff" : "overview"), [o.id]);
  const argo = o.tool === "Argo CD";
  const prot = cluster?.protected ?? false;
  const busy = o.appHealth === "Progressing" && o.reconciledSeconds < 5;

  return (
    <>
      <div className="flex flex-col gap-2 pl-3.5 pr-3 pt-2.5">
        <div className="flex items-center gap-1.5 text-ui text-fg-muted">
          <GitBranch className="size-3.5" aria-hidden />
          <span>
            {argo ? "Argo CD" : "Flux"} {o.kind}
          </span>
          <EnvironmentBadge env={o.env} className="ml-1" />
          {prot && (
            <span className="flex items-center gap-1.5 text-env-prod-ink">
              <Lock className="size-3.5" aria-hidden />
              Protected
            </span>
          )}
          <div className="flex-1" />
          <IconButton aria-label="Close inspector" onClick={onClose} className="[&_svg]:size-3.5">
            <X />
          </IconButton>
        </div>
        <h1 className="selectable m-0 truncate font-mono text-mono-title font-semibold">{o.name}</h1>
        <span className="truncate text-meta text-fg-muted">
          {o.namespace} · {o.cluster} → {o.destination}
        </span>
        <div className="flex items-center gap-3 text-cell">
          <SyncStatus sync={o.sync} />
          <AppHealthStatus health={o.appHealth} />
          <span className="text-meta text-fg-muted">reconciled {o.reconciledSeconds < 3 ? "just now" : `${formatAge(o.reconciledSeconds)} ago`}</span>
        </div>
        <dl className="m-0 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1 text-ui">
          <dt className="text-fg-muted">{o.kind === "HelmRelease" ? "Chart repo" : "Repository"}</dt>
          <dd className="m-0 truncate font-mono">{o.repo.replace(/^https?:\/\//, "")}</dd>
          <dt className="text-fg-muted">{o.kind === "HelmRelease" ? "Chart" : "Path"}</dt>
          <dd className="m-0 truncate font-mono">{o.path}</dd>
          <dt className="text-fg-muted">Target</dt>
          <dd className="m-0 truncate font-mono">
            {o.kind === "HelmRelease" ? o.target : `${o.target} @ ${o.revision}`}
          </dd>
          <dt className="text-fg-muted">{argo ? "Sync policy" : "Interval"}</dt>
          <dd className="m-0">
            {argo ? (
              <>
                {o.policy.automated ? "automated" : "manual"} · selfHeal <b className="font-semibold">{o.policy.selfHeal ? "on" : "off"}</b> · prune{" "}
                {o.policy.prune ? "on" : "off"}
              </>
            ) : (
              <>5m · prune {o.policy.prune ? "on" : "off"}{o.suspended && <> · <b className="font-semibold">suspended</b></>}</>
            )}
          </dd>
        </dl>
        <div className="flex items-center gap-1.5">
          {argo && controller?.url && (
            <Button onClick={() => window.open(`${controller.url}/applications/${o.namespace}/${o.name}`, "_blank", "noopener")}>
              <ExternalLink aria-hidden />
              Argo CD
            </Button>
          )}
          {!argo && (
            <Button onClick={() => onSuspend(!o.suspended)} className={cn(prot && "border-env-prod text-env-prod-ink")}>
              {o.suspended ? <Play aria-hidden /> : <Pause aria-hidden />}
              {o.suspended ? "Resume" : "Suspend"}
            </Button>
          )}
          <div className="flex-1" />
          <Button onClick={onRefresh} disabled={busy || cluster?.readOnly} className={cn(prot && "border-env-prod text-env-prod-ink")}>
            {prot ? <Lock aria-hidden /> : <RefreshCw aria-hidden />}
            {argo ? "Refresh" : "Reconcile"}
          </Button>
          <Button onClick={onSync} disabled={busy || o.suspended || cluster?.readOnly} className={cn(prot && "border-env-prod text-env-prod-ink")}>
            {prot ? <Lock aria-hidden /> : <RotateCw aria-hidden />}
            {argo ? "Sync…" : "Reconcile with source…"}
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList aria-label="Application sections" className="mt-1 gap-3 px-3.5 pt-1.5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="diff">
            Diff <TabCount>{o.drift.length}</TabCount>
          </TabsTrigger>
          <TabsTrigger value="resources">
            Resources <TabCount>{o.resources.length}</TabCount>
          </TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3 data-[state=inactive]:hidden">
          {o.error && (
            <div className="flex gap-[9px] rounded-lg bg-status-critical-soft px-2.5 py-[9px] text-ui">
              <StatusGlyph health="failed" className="mt-0.5" />
              <span className="selectable min-w-0 break-words font-mono text-fg-secondary">{o.error}</span>
            </div>
          )}
          <Conditions o={o} />
        </TabsContent>

        <TabsContent value="diff" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3 data-[state=inactive]:hidden">
          {o.drift.length === 0 ? (
            <p className="m-0 text-cell text-fg-secondary">
              Live state matches the desired state {argo ? "Argo CD compared" : "Flux applied"} at revision <span className="font-mono">{o.revision}</span>.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5 text-meta text-fg-muted">
                <Tag>desired</Tag>from {argo ? "Argo CD compared state" : "the last applied revision"} <Tag>live</Tag>from cluster
              </div>
              {o.drift.map((d) => (
                <div key={d.resource + d.field} className="flex flex-col overflow-hidden rounded-lg border border-line">
                  <div className="flex items-center gap-2 border-b border-line px-2.5 py-2 text-ui">
                    <Layers className="size-3.5 text-fg-muted" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-mono font-semibold">{d.resource}</span>
                    <span className="rounded-[4px] bg-status-warning-soft px-1.5 font-mono text-label font-semibold text-status-warning">drift</span>
                  </div>
                  <div className="px-2.5">
                    <div className="grid grid-cols-[minmax(0,1fr)_64px_64px] gap-x-2 py-1.5 text-ui text-fg-muted">
                      <span>Field</span>
                      <span>Desired</span>
                      <span>Live</span>
                    </div>
                    <div className="grid grid-cols-[minmax(0,1fr)_64px_64px] items-center gap-x-2 border-t border-line-row py-1.5 text-ui">
                      <span className="truncate font-mono">{d.field}</span>
                      <span className="justify-self-start rounded-[4px] bg-diff-del-bg px-1.5 font-mono text-diff-del-fg">{d.desired}</span>
                      <span className="justify-self-start rounded-[4px] bg-diff-add-bg px-1.5 font-mono text-diff-add-fg">{d.live}</span>
                    </div>
                  </div>
                  <div className="flex gap-2 border-t border-line px-2.5 py-2 text-ui text-fg-secondary">
                    <Code className="mt-px size-3.5 shrink-0 text-fg-muted" aria-hidden />
                    <span>
                      Live value written by field manager <span className="font-mono text-fg">{d.manager}</span> {d.ago} ago (managedFields).{" "}
                      {o.policy.selfHeal
                        ? `selfHeal is on, so ${o.tool} will revert it on the next reconcile.`
                        : `selfHeal is off, so ${o.tool} reports the drift but does not revert it.`}
                    </span>
                  </div>
                </div>
              ))}
              {prot && (
                <div className="flex overflow-hidden rounded-lg bg-env-prod-soft text-ui">
                  <span className="hatch-prod w-4 shrink-0" aria-hidden />
                  <span className="flex gap-2 px-2.5 py-2">
                    <Lock className="mt-px size-3.5 shrink-0 text-env-prod-ink" aria-hidden />
                    <span>
                      {argo ? "Sync and Refresh write" : "Reconcile writes"} to the {o.kind} resource on a protected cluster and ask for confirmation.{" "}
                      {o.drift[0] && `Syncing would set ${o.drift[0].field.split(".").pop()} back to ${o.drift[0].desired}.`}
                    </span>
                  </span>
                </div>
              )}
            </>
          )}
          <Conditions o={o} />
        </TabsContent>

        <TabsContent value="resources" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3.5 py-2 data-[state=inactive]:hidden">
          {o.resources.map((r) => (
            <button
              key={`${r.kind}/${r.name}`}
              type="button"
              onClick={() => onOpenYaml(r)}
              title="Open YAML"
              className="focus-ring grid h-8 grid-cols-[minmax(0,1fr)_86px_88px] items-center gap-x-2 rounded-md border-0 border-t border-line-row bg-transparent px-1 text-left text-ui text-fg first:border-t-0 hover:bg-surface-hover"
            >
              <span className="truncate">
                <span className="text-fg-muted">{r.kind}</span> <span className="font-mono">{r.name}</span>
              </span>
              <SyncStatus sync={r.status === "Missing" ? "Unknown" : r.status} />
              <AppHealthStatus health={r.health} />
            </button>
          ))}
        </TabsContent>

        <TabsContent value="history" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3.5 py-2 data-[state=inactive]:hidden">
          {o.history.map((h, i) => (
            <div key={i} className="grid h-8 grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-x-2 border-t border-line-row text-ui first:border-t-0">
              <span className="font-mono text-fg">{h.revision}</span>
              <span className="truncate text-fg-secondary">{h.message}</span>
              <span className="text-meta text-fg-muted">{h.at}</span>
            </div>
          ))}
          <p className="m-0 pt-2 text-meta text-fg-muted">
            {o.tool === "Argo CD" ? "From status.history of the Application." : "From status.history of the object."} Commit messages come from git and are not read by Clustrail.
          </p>
        </TabsContent>
      </Tabs>
    </>
  );
}

function Tag({ children }: { children: string }) {
  return <span className="rounded-[4px] bg-surface-hover px-1.5 font-mono text-label text-fg-secondary">{children}</span>;
}

function Conditions({ o }: { o: GitOpsObject }) {
  return (
    <section className="flex flex-col gap-1">
      <span className="section-label">Conditions</span>
      {o.conditions.length === 0 ? (
        <span className="flex items-center gap-2 text-ui text-fg-secondary">
          <StatusGlyph health="completed" />
          No error conditions reported
        </span>
      ) : (
        o.conditions.map((c) => (
          <span key={c.type + c.at} className="flex items-center gap-2 text-ui">
            <StatusGlyph health="failed" />
            <span className="font-mono">{c.type}</span>
            <span className="text-fg-secondary">{c.message}</span>
            <span className="ml-auto font-mono text-meta text-fg-muted">{c.at}</span>
          </span>
        ))
      )}
    </section>
  );
}
