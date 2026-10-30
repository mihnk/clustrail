import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, Box, Diff, GitBranch, Layers, Lock, Minus, Plus, ScrollText, X } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import type { Cluster, DeploymentRow, PodRelation } from "@/data/types";
import { Button, IconButton } from "@/components/ui/button";
import { Meter } from "@/components/ui/meter";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabCount } from "@/components/ui/tabs";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph, healthTone } from "@/components/status/StatusGlyph";
import { ModifyMenuButton, type ResourceAction } from "@/components/resource-actions/ResourceActions";
import { useConfirm } from "@/components/safety/ConfirmationDialog";
import { EmptyState } from "@/components/EmptyState";
import { useEvents } from "@/backend/hooks";
import { EventsPanel, RelatedList } from "@/features/pods/PodInspector";
import { backend, errorText } from "@/backend/client";
import { formatMemory } from "@/lib/format";
import { cn } from "@/lib/cn";
import { rollbackDeploymentRequest, scaleDeploymentRequest, strategyText } from "./requests";
import { t as tt, tn } from "@/i18n";

export type DeploymentTab = "overview" | "pods" | "history" | "events" | "yaml" | "related";

const problemBg: Record<string, string> = {
  failed: "bg-status-critical-soft",
  progressing: "bg-status-progressing-soft",
  paused: "bg-surface-elevated",
  warning: "bg-status-warning-soft",
};

export function DeploymentInspector({
  d,
  cluster,
  actions,
  tab,
  onTabChange,
  scaleFocusSeq,
  onClose,
}: {
  d: DeploymentRow;
  cluster: Cluster | undefined;
  actions: ResourceAction[];
  tab: DeploymentTab;
  onTabChange: (t: DeploymentTab) => void;
  /** Changes when "Scale…" is chosen from a menu: focuses the stepper. */
  scaleFocusSeq: number;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const { confirm } = useConfirm();
  const pods = ws.allPods.filter(
    (p) => p.cluster === d.cluster && p.namespace === d.namespace && p.owner?.kind === "ReplicaSet" && p.owner.name.startsWith(`${d.name}-`),
  );
  const target = { env: d.env, protected: cluster?.protected ?? false, readOnly: cluster?.readOnly };

  const openPods = () => {
    ws.openView({ kind: "pods", title: tt("Pods") });
    ws.revealResource("filter", `pods:${d.name} ns:${d.namespace} cluster:${d.cluster}`);
  };

  return (
    <>
      <div className="flex flex-col gap-2 pl-3.5 pr-3 pt-2.5">
        <div className="flex items-center gap-1.5 text-ui text-fg-muted">
          <Layers className="size-3.5" aria-hidden />
          <span>{tt("Deployment")}</span>
          <EnvironmentBadge env={d.env} className="ml-1" />
          {cluster?.protected && (
            <span className="flex items-center gap-1.5 text-env-prod-ink">
              <Lock className="size-3.5" aria-hidden />{tt("Protected")}</span>
          )}
          <div className="flex-1" />
          <IconButton aria-label={tt("Close inspector")} onClick={onClose} className="[&_svg]:size-3.5">
            <X />
          </IconButton>
        </div>
        <h1 className="selectable m-0 truncate font-mono text-mono-title font-semibold">{d.name}</h1>
        <div className="flex items-center gap-1.5 text-meta text-fg-muted">
          <span>
            {d.namespace} · {d.cluster}
          </span>
          {d.argoApp && (
            <>
              <span>·</span>
              <button
                type="button"
                onClick={() => ws.openView({ kind: "gitops", title: "GitOps" })}
                className="focus-ring flex items-center gap-1 rounded-sm border-0 bg-transparent p-0 text-meta text-accent hover:text-fg"
              >
                <GitBranch className="size-3" aria-hidden />{tt("Argo CD app {argoApp}", { argoApp: d.argoApp })}
              </button>
            </>
          )}
        </div>
        {d.health !== "healthy" && (
          <div className={cn("flex gap-[9px] rounded-lg px-2.5 py-[9px]", problemBg[d.health] ?? "bg-surface-elevated")}>
            <StatusGlyph health={d.health} className="mt-0.5" />
            <div className="flex flex-col gap-0.5 text-ui">
              <span className="font-semibold">
                <span className={healthTone[d.health]}>{d.rollout}</span>{" "}{tt("· {availableReplicas} of {replicas} replicas available", { availableReplicas: d.availableReplicas, replicas: d.replicas })}</span>
              <span className="text-fg-secondary">
                {d.reason.replace(": ", " · ")}
                {d.since ? tt(" · since {since}", { since: d.since }) : ""}
              </span>
            </div>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <Button onClick={openPods}>
            <Box aria-hidden />{tt("Pods")}</Button>
          <Button
            onClick={() =>
              ws.openView({
                kind: "logs",
                title: tt("Logs · {name}", { name: d.name }),
                cluster: d.cluster,
                params: { namespace: d.namespace, workload: d.name },
              })
            }
          >
            <ScrollText aria-hidden />{tt("Logs")}</Button>
          <Button onClick={() => onTabChange("events")} className="max-[1360px]:hidden">
            <Activity aria-hidden />{tt("Events")}</Button>
          <div className="flex-1" />
          <ModifyMenuButton
            actions={actions}
            target={target}
            cluster={d.cluster}
            includeObserve
            footnote={[
              cluster?.protected ? `${d.cluster} is protected — each change opens a confirmation.` : "",
              d.argoApp ? tt("Managed by Argo CD: direct changes may be reverted.") : "",
            ]
              .filter(Boolean)
              .join(" ")}
          />
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => onTabChange(v as DeploymentTab)} className="flex min-h-0 flex-1 flex-col">
        <TabsList aria-label={tt("Deployment sections")} className="mt-1 px-3.5 pt-1.5">
          <TabsTrigger value="overview">{tt("Overview")}</TabsTrigger>
          <TabsTrigger value="pods">{tt("Pods")}{" "}<TabCount>{pods.length}</TabCount>
          </TabsTrigger>
          <TabsTrigger value="history">{tt("History")}{" "}<TabCount>{Math.max(...d.revisions.map((r) => r.rev))}</TabCount>
          </TabsTrigger>
          <TabsTrigger value="events">{tt("Events")}</TabsTrigger>
          <TabsTrigger value="yaml">YAML</TabsTrigger>
          <TabsTrigger value="related">{tt("Related")}</TabsTrigger>
        </TabsList>

        <Panel value="overview">
          <section className="flex flex-col gap-2">
            <div className="flex items-center">
              <span className="section-label flex-1">{tt("Replicas")}</span>
              <span className="font-mono text-meta text-fg-muted">{tt("desired")}{" "}{d.replicas}
                {d.hpa ? ` · HPA ${d.hpa.min}–${d.hpa.max}` : ""}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-1">
              {pods.map((p) => (
                <span
                  key={p.id}
                  title={`${p.name} · ${p.reason}`}
                  className="flex h-[26px] items-center gap-[5px] rounded-[5px] border border-line bg-surface-app px-1.5 font-mono text-label text-fg-secondary"
                >
                  <StatusGlyph health={p.health} />
                  <span className="truncate">{p.name.split("-").pop()}</span>
                </span>
              ))}
            </div>
            <ScaleStepper d={d} cluster={cluster} focusSeq={scaleFocusSeq} onApply={(n) => confirm(scaleDeploymentRequest(d, cluster, n, () => ws.scaleDeployment(d.id, n)))} />
          </section>

          <section className="flex flex-col">
            <div className="flex items-center pb-1">
              <span className="section-label flex-1">{tt("Rollout history")}</span>
              <button
                type="button"
                onClick={() => onTabChange("history")}
                className="focus-ring rounded-sm border-0 bg-transparent p-0 text-ui text-accent hover:text-fg"
              >{tt("All")}{" "}{Math.max(...d.revisions.map((r) => r.rev))}
              </button>
            </div>
            <Revisions d={d} cluster={cluster} limit={3} />
          </section>

          {d.usage && (
            <section className="flex flex-col gap-2">
              <div className="section-label">{tt("Usage · {replicas} pods", { replicas: d.replicas })}</div>
              <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-[5px] text-ui">
                <dt className="text-fg-muted">CPU</dt>
                <dd className="m-0 flex items-center gap-1.5">
                  <Meter value={d.usage.cpuMilli / d.usage.cpuRequestMilli} label={tt("CPU used of requested")} />
                  <span className="font-mono text-meta">
                    {tt("{cpuMilli}m / {cpuRequestMilli}m req", { cpuMilli: d.usage.cpuMilli, cpuRequestMilli: d.usage.cpuRequestMilli })}</span>
                </dd>
                <dt className="text-fg-muted">{tt("Memory")}</dt>
                <dd className="m-0 flex items-center gap-1.5">
                  <Meter value={d.usage.memoryMiB / d.usage.memoryLimitMiB} label={tt("Memory used of limit")} />
                  <span className={cn("font-mono text-meta", d.usage.memoryMiB / d.usage.memoryLimitMiB >= 0.8 && "text-status-warning")}>
                    {formatMemory(d.usage.memoryMiB)} / {formatMemory(d.usage.memoryLimitMiB)} lim
                  </span>
                </dd>
                <dt className="text-fg-muted">{tt("Strategy")}</dt>
                <dd className="m-0 font-mono text-meta">{strategyText(d)}</dd>
              </dl>
            </section>
          )}
        </Panel>

        <Panel value="pods">
          {pods.length === 0 ? (
            <EmptyState title={tt("No pods")}>{tt("This Deployment has no pods right now.")}</EmptyState>
          ) : (
            <div className="flex flex-col">
              {pods.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    ws.openView({ kind: "pods", title: tt("Pods") });
                    ws.revealResource("pod", p.id);
                  }}
                  className={cn(
                    "focus-ring grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2 border-0 bg-transparent py-[7px] text-left text-ui text-fg hover:bg-surface-hover",
                    i > 0 && "border-t border-line-row",
                  )}
                >
                  <StatusGlyph health={p.health} />
                  <span className="truncate font-mono">{p.name}</span>
                  <span className={cn("font-mono", p.restarts >= 5 ? "text-status-critical" : "text-fg-muted")}>{p.restarts} ↻</span>
                </button>
              ))}
            </div>
          )}
        </Panel>

        <Panel value="history">
          <Revisions d={d} cluster={cluster} />
          <p className="m-0 text-meta text-fg-muted">{tt("Revisions come from the Deployment’s ReplicaSets (revisionHistoryLimit applies).")}</p>
        </Panel>

        <Panel value="events">
          <ObjectEvents cluster={d.cluster} namespace={d.namespace} kind="Deployment" name={d.name} />
        </Panel>

        <Panel value="yaml">
          <EmptyState
            title={tt("YAML opens in its own tab")}
            action={
              <Button
                onClick={() =>
                  ws.openView({
                    kind: "yaml",
                    title: `YAML · ${d.name}`,
                    cluster: d.cluster,
                    params: { kind: "Deployment", namespace: d.namespace, name: d.name },
                  })
                }
              >{tt("Open YAML")}</Button>
            }
          >{tt("The editor needs the width; the Deployment stays selected here.")}</EmptyState>
        </Panel>

        <Panel value="related">
          {backend ? (
            <DeploymentRelated d={d} />
          ) : (
            <dl className="m-0 flex flex-col text-ui">
              <Rel label={tt("Selected by")} via={tt("Service selector")}>{tt("svc/{name}", { name: d.name })}
              </Rel>
              {d.hpa && (
                <Rel label={tt("Scaled by")} via={tt("scaleTargetRef")}>{tt("hpa/{name} · {min}–{max}", { name: d.hpa.name, min: d.hpa.min, max: d.hpa.max })}
                </Rel>
              )}
              <Rel label={tt("Disruption")} via={tt("PDB selector")}>{tt("pdb/{name}", { name: d.name })}
              </Rel>
              {d.argoApp && (
                <Rel label={tt("Managed by")} via={tt("Argo CD tracking annotation")}>{tt("Argo CD · {argoApp}", { argoApp: d.argoApp })}
                </Rel>
              )}
            </dl>
          )}
        </Panel>
      </Tabs>
    </>
  );
}

function Panel({ value, children }: { value: DeploymentTab; children: ReactNode }) {
  return (
    <TabsContent value={value} className="focus-ring flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3.5 py-3">
      {children}
    </TabsContent>
  );
}

function Rel({ label, via, children }: { label: string; via: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-2.5 py-1.5">
      <dt className="text-meta text-fg-muted">{label}</dt>
      <dd className="m-0 flex flex-col gap-0.5">
        <span className="font-mono">{children}</span>
        <span className="text-label text-fg-muted">{tt("via")}{" "}{via}</span>
      </dd>
    </div>
  );
}

function Revisions({ d, cluster, limit }: { d: DeploymentRow; cluster: Cluster | undefined; limit?: number }) {
  const ws = useWorkspace();
  const { confirm } = useConfirm();
  const current = Math.max(...d.revisions.map((r) => r.rev));
  const list = [...d.revisions].sort((a, b) => b.rev - a.rev).slice(0, limit);
  const locked = cluster?.protected;
  return (
    <div className="flex flex-col">
      {list.map((r, i) => (
        <div
          key={r.rev}
          className={cn("grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-x-2 py-[7px] text-ui", i > 0 && "border-t border-line-row")}
        >
          <span className={cn("font-mono", r.rev === current ? "text-accent" : "text-fg-muted")}>{r.rev}</span>
          <span className="truncate">
            <span className="font-mono">{r.image}</span>{" "}
            <span className="text-fg-muted">
              · {r.rev === current ? tt("current · ") : ""}
              {r.age}
              {r.sync ? tt(" · sync {sync}", { sync: r.sync }) : ""}
            </span>
          </span>
          {r.rev === current ? (
            <span className="rounded bg-surface-hover px-[5px] py-[3px] font-mono text-2xs leading-none text-fg-secondary">{tt("current")}</span>
          ) : (
            <span className="flex gap-1">
              <Button size="sm" disabled title={tt("Opens the YAML diff (not implemented in this build).")}>
                <Diff aria-hidden />{tt("Diff")}</Button>
              <Button
                size="sm"
                variant={locked ? "locked" : "default"}
                disabled={cluster?.readOnly}
                onClick={() => confirm(rollbackDeploymentRequest(d, cluster, r.rev, () => ws.rollbackDeployment(d.id, r.rev)))}
              >
                {locked && <Lock aria-hidden />}{tt("Roll back")}</Button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function ScaleStepper({
  d,
  cluster,
  focusSeq,
  onApply,
}: {
  d: DeploymentRow;
  cluster: Cluster | undefined;
  focusSeq: number;
  onApply: (replicas: number) => void;
}) {
  const [value, setValue] = useState(d.replicas);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(d.replicas), [d.id, d.replicas]);
  useEffect(() => {
    if (focusSeq > 0) inputRef.current?.focus();
  }, [focusSeq]);
  const changed = value !== d.replicas;
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center overflow-hidden rounded-md border border-line-strong">
        <IconButton aria-label={tt("Decrease replicas")} className="rounded-none" disabled={cluster?.readOnly || value <= 0} onClick={() => setValue(value - 1)}>
          <Minus />
        </IconButton>
        <input
          ref={inputRef}
          aria-label={tt("Replicas")}
          inputMode="numeric"
          value={value}
          disabled={cluster?.readOnly}
          onChange={(e) => setValue(Math.max(0, Number(e.target.value.replace(/\D/g, "")) || 0))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && changed) onApply(value);
            if (e.key === "ArrowUp") setValue(value + 1);
            if (e.key === "ArrowDown") setValue(Math.max(0, value - 1));
          }}
          className="h-7 w-[34px] border-0 bg-transparent text-center font-mono text-cell text-fg outline-none focus:bg-accent-soft"
        />
        <IconButton aria-label={tt("Increase replicas")} className="rounded-none" disabled={cluster?.readOnly} onClick={() => setValue(value + 1)}>
          <Plus />
        </IconButton>
      </div>
      {changed ? (
        <span className="flex items-center gap-1">
          <Button size="sm" variant={cluster?.protected ? "locked" : "primary"} onClick={() => onApply(value)}>
            {cluster?.protected && <Lock aria-hidden />}{tt("Apply")}{" "}{value}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setValue(d.replicas)}>{tt("Reset")}</Button>
        </span>
      ) : d.hpa ? (
        <span className="text-meta leading-[1.35] text-fg-muted">{tn("HPA {name} sets replicas. A manual scale is overridden.", { name: <span className="font-mono">{d.hpa.name}</span> })}</span>
      ) : null}
    </div>
  );
}

function ObjectEvents({ cluster, namespace, kind, name }: { cluster: string; namespace: string; kind: string; name: string }) {
  const events = useEvents(cluster, namespace, kind, name, true);
  if (events === null) return <EmptyState title={tt("Reading events…")} />;
  if (!events.length) return <EmptyState title={tt("No recent events")}>{tt("The API server keeps events for about 1 hour by default.")}</EmptyState>;
  return <EventsPanel events={events} />;
}

/** Desktop: what selects, scales, protects and configures this Deployment, as the API server reports it. */
function DeploymentRelated({ d }: { d: DeploymentRow }) {
  const [rels, setRels] = useState<PodRelation[] | { error: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRels(null);
    void backend
      ?.deploymentRelations(d.cluster, d.namespace, d.name)
      .then((r) => !cancelled && setRels(r))
      .catch((e) => !cancelled && setRels({ error: errorText(e) }));
    return () => {
      cancelled = true;
    };
  }, [d.id]);
  if (rels === null) return <EmptyState title={tt("Finding related objects…")} />;
  if ("error" in rels) return <EmptyState title={tt("Could not read related objects")}>{rels.error}</EmptyState>;
  if (!rels.length) return <EmptyState title={tt("No related objects")}>{tt("No Service, HPA, PodDisruptionBudget or configuration references this Deployment.")}</EmptyState>;
  return <RelatedList relations={rels} />;
}
