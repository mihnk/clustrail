import { useEffect, useMemo, useState } from "react";
import { ArrowUpCircle, Code, Diff, History, Info, LifeBuoy, Lock, X } from "lucide-react";
import type { Cluster } from "@/data/types";
import { rollbackPlan, type HelmRelease } from "@/data/helm";
import { hunks, lineDiff } from "@/data/compare";
import { Button, IconButton } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabCount } from "@/components/ui/tabs";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { formatAge } from "@/lib/format";
import { cn } from "@/lib/cn";

const HELM_SDK = "3.16";

function manifestFor(r: HelmRelease, appVersion: string, rev: number): string {
  const parts = r.resources
    .filter((o) => !(o.kind === "ServiceMonitor" && rev < 8 && r.name === "payments-workers"))
    .map((o) => {
      const lines = [`---`, `# Source: ${r.chart}/templates/${o.kind.toLowerCase()}.yaml`, `apiVersion: v1`, `kind: ${o.kind}`, `metadata:`, `  name: ${o.name}`, `  namespace: ${r.namespace}`];
      if (o.kind === "Deployment") lines.push(`spec:`, `  template:`, `    spec:`, `      containers:`, `        - name: ${r.name}`, `          image: ghcr.io/acme/${r.name}:${appVersion}`);
      if (o.kind === "CronJob") lines.push(`spec:`, `  schedule: "${rev >= 8 ? "*/10 * * * *" : "*/15 * * * *"}"`);
      if (o.kind === "ConfigMap") lines.push(`data:`, `  QUEUE_PREFETCH: "${rev >= 8 ? "50" : "20"}"`, `  BATCH_SIZE: "${rev >= 8 ? "500" : "200"}"`);
      return lines.join("\n");
    });
  return parts.join("\n");
}

/** Chart defaults merged under the user-supplied values (helm get values --all). */
function computedValues(r: HelmRelease): string {
  const defaults = `# chart defaults (${r.chart} ${r.chartVersion})
nameOverride: ""
fullnameOverride: ""
podAnnotations: {}
securityContext:
  runAsNonRoot: true
  readOnlyRootFilesystem: true
service:
  type: ClusterIP
  port: 8080
nodeSelector: {}
tolerations: []
affinity: {}
`;
  return r.values.startsWith("#") ? defaults : `${defaults}# user-supplied\n${r.values}`;
}

export function HelmInspector({
  release: r,
  cluster,
  onClose,
  onRollback,
}: {
  release: HelmRelease;
  cluster: Cluster | undefined;
  onClose: () => void;
  onRollback: (rev: number) => void;
}) {
  const current = r.history[0]!;
  const lastGood = r.history.find((h) => h.rev !== r.revision && (h.status === "deployed" || h.status === "superseded"));
  const [tab, setTab] = useState(r.status === "failed" ? "history" : "overview");
  const [target, setTarget] = useState<number | null>(lastGood?.rev ?? null);
  const [showDiff, setShowDiff] = useState(false);
  const [valuesMode, setValuesMode] = useState<"user" | "computed">("user");
  const busy = r.status.startsWith("pending") && r.updatedSeconds < 60;

  useEffect(() => {
    setTab(r.status === "failed" ? "history" : "overview");
    setTarget(lastGood?.rev ?? null);
    setShowDiff(false);
  }, [r.id]);

  const plan = target !== null ? rollbackPlan(r, target) : null;
  const targetRev = r.history.find((h) => h.rev === target);
  const diff = useMemo(
    () => (targetRev ? hunks(lineDiff(manifestFor(r, current.appVersion, current.rev), manifestFor(r, targetRev.appVersion, targetRev.rev)), 1) : []),
    [r, current, targetRev],
  );

  return (
    <>
      <div className="flex flex-col gap-2 pl-3.5 pr-3 pt-2.5">
        <div className="flex items-center gap-1.5 text-ui text-fg-muted">
          <LifeBuoy className="size-3.5" aria-hidden />
          <span>Helm release</span>
          <EnvironmentBadge env={r.env} className="ml-1" />
          {cluster?.protected && (
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
        <h1 className="selectable m-0 truncate font-mono text-mono-title font-semibold">{r.name}</h1>
        <span className="truncate text-meta text-fg-muted">
          {r.namespace} · {r.cluster} · {r.repoKnown ? r.chart : `acme/${r.chart}`} {r.chartVersion} · app {r.appVersion}
        </span>

        {r.status === "failed" && (
          <div className="flex gap-[9px] rounded-lg bg-status-critical-soft px-2.5 py-[9px] text-ui">
            <StatusGlyph health="failed" className="mt-0.5" />
            <div className="flex min-w-0 flex-col gap-1">
              <span>
                <b className="font-semibold text-status-critical">Upgrade to revision {r.revision} failed</b> · {formatAge(r.updatedSeconds)} ago
              </span>
              <span className="selectable font-mono text-fg-secondary">
                context deadline exceeded: Deployment {r.name} not ready within --timeout 5m
              </span>
            </div>
          </div>
        )}
        {r.status === "pending-upgrade" && r.updatedSeconds > 3600 && (
          <div className="flex gap-[9px] rounded-lg bg-status-warning-soft px-2.5 py-[9px] text-ui">
            <StatusGlyph health="warning" className="mt-0.5" />
            <span>
              <b className="font-semibold">pending-upgrade for {formatAge(r.updatedSeconds)}.</b>{" "}
              <span className="text-fg-secondary">
                Helm marks a release pending while an operation runs. If the process that started it stopped, the release stays pending and the next
                upgrade fails with “another operation is in progress”. Rolling back to the last deployed revision clears it.
              </span>
            </span>
          </div>
        )}

        <div className="flex flex-col gap-1.5 text-ui">
          <span className="flex min-w-0 items-center gap-2">
            <SourceBadge>Observed</SourceBadge>
            <span className="truncate text-fg-secondary">
              release Secret <span className="font-mono">sh.helm.release.v1.{r.name}.v{r.revision}</span>
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <SourceBadge op>Helm ops</SourceBadge>
            <span className="truncate text-fg-secondary">
              bundled Helm SDK {HELM_SDK} · chart repo {r.repoKnown ? <span className="text-fg">configured</span> : <span className="text-status-warning">unknown</span>}
            </span>
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <Button onClick={() => setTab("manifest")}>
            <Code aria-hidden />
            Manifest
          </Button>
          <div className="flex-1" />
          <Button
            disabled
            title={r.repoKnown ? "Upgrades run from your CI pipeline in this build" : `Chart repository for acme/${r.chart} is not configured`}
          >
            <ArrowUpCircle aria-hidden />
            Upgrade…
          </Button>
          <Button
            disabled={!lastGood || busy || cluster?.readOnly}
            className={cn(tab === "history" && "border-line-selected bg-accent-soft")}
            onClick={() => {
              setTab("history");
              setTarget(lastGood?.rev ?? null);
            }}
          >
            <History aria-hidden />
            Roll back…
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList aria-label="Release sections" className="mt-1 gap-3 px-3.5 pt-1.5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="values">Values</TabsTrigger>
          <TabsTrigger value="manifest">Manifest</TabsTrigger>
          <TabsTrigger value="history">
            History <TabCount>{r.history.length}</TabCount>
          </TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3 data-[state=inactive]:hidden">
          <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-cell">
            <dt className="text-fg-muted">Status</dt>
            <dd className="m-0">{r.status}</dd>
            <dt className="text-fg-muted">Revision</dt>
            <dd className="m-0 font-mono">{r.revision}</dd>
            <dt className="text-fg-muted">Updated</dt>
            <dd className="m-0">{r.updatedSeconds < 5 ? "now" : `${formatAge(r.updatedSeconds)} ago`}</dd>
            <dt className="text-fg-muted">Description</dt>
            <dd className="selectable m-0">{current.description}</dd>
          </dl>
          <div className="flex flex-col">
            <span className="section-label pb-1">Resources · {r.resources.length}</span>
            {r.resources.map((o) => (
              <div key={`${o.kind}/${o.name}`} className="flex h-7 items-center gap-2 border-t border-line-row text-cell first:border-t-0">
                <span className="w-[104px] shrink-0 text-fg-muted">{o.kind}</span>
                <span className="truncate font-mono text-ui">{o.name}</span>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="values" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3.5 py-3 data-[state=inactive]:hidden">
          <div className="flex items-center gap-2">
            <Segmented
              aria-label="Values"
              value={valuesMode}
              onValueChange={setValuesMode}
              options={[
                { value: "user", label: "User-supplied" },
                { value: "computed", label: "Computed" },
              ]}
            />
          </div>
          <span className="text-meta text-fg-muted">
            {valuesMode === "user" ? "helm get values" : "helm get values --all: chart defaults merged with user values"} · revision {r.revision}. Values that look like
            credentials are redacted.
          </span>
          <pre className="selectable m-0 overflow-x-auto rounded-md bg-term-bg px-2.5 py-2 font-mono text-[11.5px] leading-[17px] text-term-fg">
            {valuesMode === "user" ? r.values : computedValues(r)}
          </pre>
        </TabsContent>

        <TabsContent value="manifest" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3.5 py-3 data-[state=inactive]:hidden">
          <span className="text-meta text-fg-muted">Rendered manifest stored in the release Secret of revision {r.revision}.</span>
          <pre className="selectable m-0 overflow-x-auto rounded-md bg-term-bg px-2.5 py-2 font-mono text-[11.5px] leading-[17px] text-term-fg">
            {manifestFor(r, current.appVersion, current.rev)}
          </pre>
        </TabsContent>

        <TabsContent value="history" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3 data-[state=inactive]:hidden">
          <div role="listbox" aria-label="Revisions" className="flex flex-col">
            {r.history.map((h) => {
              const isCurrent = h.rev === r.revision;
              const selected = h.rev === target;
              return (
                <button
                  key={h.rev}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={isCurrent}
                  onClick={() => {
                    setTarget(h.rev);
                    setShowDiff(false);
                  }}
                  className={cn(
                    "focus-ring grid grid-cols-[26px_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md border-0 bg-transparent px-2 py-[7px] text-left text-ui text-fg enabled:hover:bg-surface-hover disabled:cursor-default",
                    selected && "bg-surface-selected shadow-[inset_0_0_0_1px_var(--line-selected)] enabled:hover:bg-surface-selected",
                  )}
                >
                  <span className={cn("font-mono", h.status === "failed" ? "text-status-critical" : selected ? "text-accent" : isCurrent ? "text-fg" : "text-fg-muted")}>{h.rev}</span>
                  <span className={cn("truncate", !isCurrent && !selected && "text-fg-secondary")}>
                    <span className={cn(h.status === "failed" && "text-status-critical", h.status.startsWith("pending") && "text-status-progressing")}>{h.status}</span>{" "}
                    <span className="font-mono text-fg-secondary">
                      {h.chartVersion} · {h.appVersion}
                    </span>{" "}
                    <span className="text-fg-muted">· {h.updatedSeconds < 5 ? "now" : formatAge(h.updatedSeconds)}</span>
                  </span>
                  {selected ? (
                    <span className="rounded-[4px] bg-accent-soft px-1.5 font-mono text-label text-accent">target</span>
                  ) : isCurrent ? (
                    <span className="font-mono text-label text-fg-muted">current</span>
                  ) : (
                    <span />
                  )}
                </button>
              );
            })}
          </div>

          {plan && targetRev && (
            <section aria-label={`Roll back to revision ${target}`} className="flex flex-col gap-2 rounded-lg border border-line p-2.5">
              <div className="flex items-center gap-2">
                <b className="flex-1 text-cell font-semibold">Roll back to revision {target}</b>
                <EnvironmentBadge env={r.env} />
              </div>
              <dl className="m-0 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1 text-ui">
                <dt className="text-fg-muted">Changed</dt>
                <dd className="m-0">{plan.changed}</dd>
                {plan.removed && (
                  <>
                    <dt className="text-fg-muted">Removed</dt>
                    <dd className="m-0">{plan.removed}</dd>
                  </>
                )}
                {plan.hooks && (
                  <>
                    <dt className="text-fg-muted">Hooks</dt>
                    <dd className="m-0">{plan.hooks}</dd>
                  </>
                )}
                <dt className="text-fg-muted">Options</dt>
                <dd className="m-0">{plan.options}</dd>
              </dl>
              {showDiff && (
                <div className="flex flex-col gap-1.5">
                  {diff.map((h, i) => (
                    <div key={i} className="selectable overflow-x-auto rounded-md border border-line bg-term-bg">
                      {h.map((l, j) => (
                        <div
                          key={j}
                          className={cn(
                            "whitespace-pre px-2 font-mono text-[11px] leading-[17px]",
                            l.op === "+" ? "bg-diff-add-bg text-diff-add-fg" : l.op === "-" ? "bg-diff-del-bg text-diff-del-fg" : "text-term-fg",
                          )}
                        >
                          {l.op} {l.text}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <Button size="sm" aria-pressed={showDiff} onClick={() => setShowDiff(!showDiff)}>
                  <Diff aria-hidden />
                  Manifest diff
                </Button>
                <div className="flex-1" />
                <Button size="sm" variant="primary" disabled={busy || cluster?.readOnly} onClick={() => onRollback(targetRev.rev)}>
                  Roll back…
                </Button>
              </div>
            </section>
          )}

          {!r.repoKnown && (
            <div role="status" className="flex gap-2 rounded-lg bg-status-progressing-soft px-2.5 py-2 text-ui">
              <Info className="mt-px size-3.5 shrink-0 text-status-progressing" aria-hidden />
              <span>
                Upgrade needs the chart. Add the repo that hosts <span className="font-mono">acme/{r.chart}</span> in Settings › Helm, or upgrade from your CI
                pipeline.
              </span>
            </div>
          )}
        </TabsContent>

        <TabsContent value="notes" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3.5 py-3 data-[state=inactive]:hidden">
          <pre className="selectable m-0 whitespace-pre-wrap font-mono text-ui text-fg-secondary">{r.notes}</pre>
        </TabsContent>
      </Tabs>
    </>
  );
}

function SourceBadge({ children, op }: { children: string; op?: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-[4px] px-[5px] py-[3px] font-mono text-[10px] font-semibold uppercase leading-none tracking-[.04em]",
        op ? "text-accent shadow-[inset_0_0_0_1px_var(--line-selected)]" : "text-fg-secondary shadow-[inset_0_0_0_1px_var(--line-strong)]",
      )}
    >
      {children}
    </span>
  );
}
