import { useState, type ReactNode } from "react";
import { Check, Copy, Droplet, Filter, Lock, Server, X } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import type { Cluster } from "@/data/types";
import type { NodeRow } from "@/data/nodes";
import { Button, IconButton } from "@/components/ui/button";
import { CapacityBar } from "@/components/ui/meter";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabCount } from "@/components/ui/tabs";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { ModifyMenuButton, type ResourceAction } from "@/components/resource-actions/ResourceActions";
import { EmptyState } from "@/components/EmptyState";
import { useEvents } from "@/backend/hooks";
import { EventsPanel } from "@/features/pods/PodInspector";
import { cn } from "@/lib/cn";
import { ago, t as tt } from "@/i18n";

export function NodeInspector({
  node,
  cluster,
  actions,
  onClose,
  onUncordon,
  onDrain,
}: {
  node: NodeRow;
  cluster: Cluster | undefined;
  actions: ResourceAction[];
  onClose: () => void;
  onUncordon: () => void;
  onDrain: () => void;
}) {
  const ws = useWorkspace();
  const [copied, setCopied] = useState(false);
  const pods = ws.allPods.filter((p) => p.cluster === node.cluster && p.node === node.name);
  const target = { env: node.env, protected: cluster?.protected ?? false, readOnly: cluster?.readOnly };

  return (
    <>
      <div className="flex flex-col gap-2 pl-3.5 pr-3 pt-2.5">
        <div className="flex items-center gap-1.5 text-ui text-fg-muted">
          <Server className="size-3.5" aria-hidden />
          <span>{tt("Node")}</span>
          <EnvironmentBadge env={node.env} className="ml-1" />
          {cluster?.protected && (
            <span className="flex items-center gap-1.5 text-env-prod-ink">
              <Lock className="size-3.5" aria-hidden />{tt("Protected")}</span>
          )}
          <div className="flex-1" />
          <IconButton aria-label={tt("Close inspector")} onClick={onClose} className="[&_svg]:size-3.5">
            <X />
          </IconButton>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <h1 className="selectable m-0 truncate font-mono text-mono-title font-semibold" title={node.name}>
            {node.name}
          </h1>
          <IconButton
            aria-label={copied ? tt("Copied") : tt("Copy name")}
            className="size-[22px] [&_svg]:size-3.5"
            onClick={() =>
              void navigator.clipboard?.writeText(node.name).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              })
            }
          >
            {copied ? <Check className="text-status-healthy" /> : <Copy />}
          </IconButton>
        </div>
        <span className="truncate text-meta text-fg-muted">
          {node.cluster} · {node.instanceType} · {node.zone} · {node.gitVersion}
        </span>
        {node.health === "cordoned" && (
          <div className="flex gap-[9px] rounded-lg bg-status-progressing-soft px-2.5 py-[9px] text-ui">
            <StatusGlyph health="cordoned" className="mt-0.5" />
            <div className="flex flex-1 flex-col gap-1.5">
              <span>
                <b className="font-semibold">{tt("Cordoned {cordonedAgo}", { cordonedAgo: node.cordonedAgo })}</b>{" "}
                <span className="text-fg-secondary">{tt("by {cordonedBy} · new pods won’t schedule here. {pods} pods still running.", { cordonedBy: node.cordonedBy, pods: node.pods })}</span>
              </span>
              <div className="flex gap-1.5">
                <Button size="sm" onClick={onUncordon} disabled={cluster?.readOnly}>{tt("Uncordon")}</Button>
                <Button
                  size="sm"
                  onClick={onDrain}
                  disabled={cluster?.readOnly}
                  className={cn(cluster?.protected && "border-env-prod bg-transparent text-env-prod-ink")}
                >
                  <Filter aria-hidden />{tt("Drain…")}</Button>
              </div>
            </div>
          </div>
        )}
        {node.health === "failed" && (
          <div className="flex gap-[9px] rounded-lg bg-status-critical-soft px-2.5 py-[9px] text-ui">
            <StatusGlyph health="failed" className="mt-0.5" />
            <span>
              <b className="font-semibold text-status-critical">{tt("NotReady")}</b> <span className="text-fg-secondary">· {tt("{reason}. Last heartbeat {heartbeat}.", { reason: node.reason, heartbeat: ago(node.heartbeat) })}</span>
            </span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <Button
            onClick={() => {
              ws.openView({ kind: "pods", title: tt("Pods") });
              ws.revealResource("filter", `pods:node:${node.name.split(".")[0]} cluster:${node.cluster}`);
            }}
          >{tt("Pods on node")}</Button>
          <div className="flex-1" />
          <ModifyMenuButton actions={actions} target={target} cluster={node.cluster} />
        </div>
      </div>

      <Tabs defaultValue="conditions" className="flex min-h-0 flex-1 flex-col">
        <TabsList aria-label={tt("Node sections")} className="mt-1 gap-3 px-3.5 pt-1.5">
          <TabsTrigger value="conditions">{tt("Conditions")}</TabsTrigger>
          <TabsTrigger value="pods">{tt("Pods")}{" "}<TabCount>{node.pods}</TabCount>
          </TabsTrigger>
          <TabsTrigger value="allocated">{tt("Allocated")}</TabsTrigger>
          <TabsTrigger value="labels">{tt("Labels")}</TabsTrigger>
          <TabsTrigger value="taints">{tt("Taints")}{" "}<TabCount>{node.taints.length}</TabCount>
          </TabsTrigger>
          <TabsTrigger value="events">{tt("Events")}</TabsTrigger>
        </TabsList>

        <Panel value="conditions">
          <Conditions node={node} />
          <Allocated node={node} metrics={cluster?.metrics !== null} />
          <Taints node={node} />
        </Panel>
        <Panel value="pods">
          {pods.length === 0 ? (
            <EmptyState title={tt("No pods from the loaded clusters")}>{tt("The node reports {pods} pods; open the Pods explorer filtered to this node to list them.", { pods: node.pods })}</EmptyState>
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
                  <span className="truncate font-mono">
                    {p.namespace}/{p.name}
                  </span>
                  <span className="text-fg-muted">{p.owner?.kind ?? tt("no owner")}</span>
                </button>
              ))}
            </div>
          )}
        </Panel>
        <Panel value="allocated">
          <Allocated node={node} metrics={cluster?.metrics !== null} />
          <p className="m-0 text-meta text-fg-muted">{tt("Requests and limits are summed from the pods scheduled here; allocatable comes from node status. Usage is current, from metrics-server.")}</p>
        </Panel>
        <Panel value="labels">
          <dl className="m-0 flex flex-col gap-1 text-ui">
            {Object.entries(node.labels).map(([k, v]) => (
              <div key={k} className="flex min-w-0 gap-1 font-mono">
                <dt className="truncate text-fg-muted">{k}</dt>
                <dd className="m-0 truncate">{v ? `= ${v}` : ""}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel value="taints">
          <Taints node={node} />
        </Panel>
        <Panel value="events">
          <ObjectEvents cluster={node.cluster} namespace={""} kind="Node" name={node.name} />
        </Panel>
      </Tabs>
    </>
  );
}

function Panel({ value, children }: { value: string; children: ReactNode }) {
  return (
    <TabsContent value={value} className="focus-ring flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3.5 py-3">
      {children}
    </TabsContent>
  );
}

function Conditions({ node }: { node: NodeRow }) {
  return (
    <section className="flex flex-col">
      <div className="grid grid-cols-[14px_minmax(0,1fr)_56px_64px] gap-x-2 pb-1 text-label text-fg-muted">
        <span />
        <span>{tt("Condition")}</span>
        <span>{tt("Status")}</span>
        <span>{tt("Since")}</span>
      </div>
      {node.conditions.map((c) => (
        <div key={c.type} className="grid grid-cols-[14px_minmax(0,1fr)_56px_64px] items-center gap-x-2 border-t border-line-row py-1.5 text-ui">
          <StatusGlyph health={c.ok ? "healthy" : c.status === "Unknown" ? "unknown" : "warning"} />
          <span>
            {c.type}
            {c.reason && <span className="text-fg-muted"> · {c.reason}</span>}
          </span>
          <span className="font-mono">{c.status}</span>
          <span className="font-mono text-fg-muted">{c.since}</span>
        </div>
      ))}
      <span className={cn("pt-1.5 text-meta", node.health === "failed" ? "text-status-critical" : "text-fg-muted")}>{tt("Last heartbeat {heartbeat}", { heartbeat: ago(node.heartbeat) })}</span>
    </section>
  );
}

function Allocated({ node, metrics }: { node: NodeRow; metrics: boolean }) {
  const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}%`;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center">
        <span className="section-label flex-1">{tt("Allocated vs allocatable")}</span>
        <span className="text-meta text-fg-muted">{metrics ? tt("usage from metrics") : tt("no usage data")}</span>
      </div>
      <div className="grid grid-cols-[58px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-[3px] text-ui">
        <span className="text-fg-secondary">CPU</span>
        <CapacityBar used={metrics ? node.cpu.used : null} requested={node.cpu.requests} allocatable={node.cpu.allocatable} label={tt("CPU allocation")} />
        <span />
        <span className="font-mono text-meta text-fg-muted">
          {metrics && node.cpu.used !== null ? tt("used {used} · ", { used: node.cpu.used }) : ""}{tt("requests")}{" "}{node.cpu.requests} ({pct(node.cpu.requests, node.cpu.allocatable)}{tt(") · limits")}{" "}
          {node.cpu.limits} ({pct(node.cpu.limits, node.cpu.allocatable)}) / {node.cpu.allocatable}{" "}{tt("cores")}</span>
        <span className="text-fg-secondary">{tt("Memory")}</span>
        <CapacityBar used={metrics ? node.memoryGiB.used : null} requested={node.memoryGiB.requests} allocatable={node.memoryGiB.allocatable} label={tt("Memory allocation")} />
        <span />
        <span className="font-mono text-meta text-fg-muted">
          {metrics && node.memoryGiB.used !== null ? tt("used {used} · ", { used: node.memoryGiB.used }) : ""}{tt("requests")}{" "}{node.memoryGiB.requests} (
          {pct(node.memoryGiB.requests, node.memoryGiB.allocatable)}) / {node.memoryGiB.allocatable}{" "}{tt("GiB")}</span>
        <span className="text-fg-secondary">{tt("Pods")}</span>
        <CapacityBar used={node.pods} requested={0} allocatable={node.podCapacity} label={tt("Pods scheduled")} />
        <span />
        <span className="font-mono text-meta text-fg-muted">
          {node.pods} / {node.podCapacity}
        </span>
      </div>
    </section>
  );
}

function Taints({ node }: { node: NodeRow }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="section-label">{tt("Taints")}</div>
      {node.taints.length === 0 && <span className="text-ui text-fg-muted">{tt("No taints.")}</span>}
      {node.taints.map((t) => (
        <div key={t.key + t.effect} className="flex items-center gap-1.5 font-mono text-ui">
          <Droplet className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
          <span className="truncate">
            {t.key}
            {t.value ? `=${t.value}` : ""}
          </span>
          <span className="rounded bg-status-progressing-soft px-[5px] py-[3px] text-2xs font-semibold leading-none text-status-progressing">{t.effect}</span>
        </div>
      ))}
      {node.taints.some((t) => t.key === "node.kubernetes.io/unschedulable") && <span className="text-meta text-fg-muted">{tt("Added by cordon. Removed by Uncordon.")}</span>}
    </section>
  );
}

function ObjectEvents({ cluster, namespace, kind, name }: { cluster: string; namespace: string; kind: string; name: string }) {
  const events = useEvents(cluster, namespace, kind, name, true);
  if (events === null) return <EmptyState title={tt("Reading events…")} />;
  if (!events.length) return <EmptyState title={tt("No recent events")}>{tt("The API server keeps events for about 1 hour by default.")}</EmptyState>;
  return <EventsPanel events={events} />;
}
