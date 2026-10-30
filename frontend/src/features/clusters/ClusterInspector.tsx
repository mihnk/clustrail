import type { ReactNode } from "react";
import { Activity, Box, GitBranch, Layers, LifeBuoy, Lock, Network, Server, X } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import type { Cluster } from "@/data/types";
import type { ClusterOverview } from "@/data/clusterOverview";
import { IconButton } from "@/components/ui/button";
import { CapacityBar } from "@/components/ui/meter";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabCount } from "@/components/ui/tabs";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { CountPill } from "@/components/status/ResourceStatus";
import { StatusGlyph, healthTone } from "@/components/status/StatusGlyph";
import { DisconnectedCluster, isOffline } from "@/components/cluster/ClusterStates";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/cn";

export function ClusterInspector({
  cluster,
  ov,
  pods,
  podsAttention,
  onClose,
}: {
  cluster: Cluster;
  ov: ClusterOverview;
  pods: number;
  podsAttention: number;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const offline = isOffline(cluster);
  const scopeTo = (kind: "pods" | "deployments" | "nodes" | "helm" | "gitops") => {
    // Opens the explorer filtered to this cluster without changing the global selection.
    if (!ws.selectedClusterIds.includes(cluster.id)) ws.toggleCluster(cluster.id, true);
    ws.openView({ kind, title: kind[0]!.toUpperCase() + kind.slice(1) });
    ws.revealResource("filter", `${kind}:cluster:${cluster.id}`);
  };

  return (
    <>
      <div className="flex flex-col gap-2 pl-3.5 pr-3 pt-2.5">
        <div className="flex items-center gap-1.5 text-ui text-fg-muted">
          <Network className="size-3.5" aria-hidden />
          <span>Cluster</span>
          <EnvironmentBadge env={cluster.env} className="ml-1" />
          {cluster.protected && (
            <span className="flex items-center gap-1.5 text-env-prod-ink">
              <Lock className="size-3.5" aria-hidden />
              Protected
            </span>
          )}
          {cluster.readOnly && <span className="text-fg-secondary">Read-only</span>}
          <div className="flex-1" />
          <IconButton aria-label="Close inspector" onClick={onClose} className="[&_svg]:size-3.5">
            <X />
          </IconButton>
        </div>
        <h1 className="selectable m-0 font-mono text-mono-title font-semibold">{cluster.name}</h1>
        <span className="truncate text-meta text-fg-muted">
          {ov.provider} · {ov.region} · {ov.gitVersion}
        </span>
        {!offline && (
          <div className="grid grid-cols-3 gap-1.5">
            <Quick icon={<Box />} label="Pods" onClick={() => scopeTo("pods")}>
              {pods}
              {podsAttention > 0 && <CountPill tone="critical">{podsAttention}</CountPill>}
            </Quick>
            <Quick icon={<Layers />} label="Deploys" onClick={() => scopeTo("deployments")}>
              {ov.quick.deployments}
              {ov.quick.deploymentsAttention > 0 && <CountPill tone="critical">{ov.quick.deploymentsAttention}</CountPill>}
            </Quick>
            <Quick icon={<Server />} label="Nodes" onClick={() => scopeTo("nodes")}>
              {ov.nodes.total}
            </Quick>
            <Quick icon={<Activity />} label="Events" disabled>
              <CountPill tone="warning">{ov.quick.events}</CountPill>
              <span className="text-fg-muted">1h</span>
            </Quick>
            <Quick icon={<LifeBuoy />} label="Helm" onClick={() => scopeTo("helm")}>
              {ov.quick.helm}
            </Quick>
            <Quick icon={<GitBranch />} label="GitOps" disabled={!ov.quick.gitops} onClick={() => scopeTo("gitops")}>
              {ov.quick.gitops ?? "not detected"}
            </Quick>
          </div>
        )}
      </div>

      {offline ? (
        <div className="p-3.5">
          <DisconnectedCluster cluster={cluster} />
        </div>
      ) : (
        <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
          <TabsList aria-label="Cluster sections" className="mt-2 px-3.5">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="capacity">Capacity</TabsTrigger>
            <TabsTrigger value="components">Components</TabsTrigger>
            <TabsTrigger value="events">
              Events <TabCount>{ov.quick.events}</TabCount>
            </TabsTrigger>
          </TabsList>
          <Panel value="overview">
            {ov.attention.length > 0 && (
              <section className="flex flex-col">
                <div className="section-label pb-1.5">Needs attention</div>
                {ov.attention.map((a, i) => (
                  <div
                    key={a.name}
                    className={cn("grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2 py-[7px] text-ui", i > 0 && "border-t border-line-row")}
                  >
                    <StatusGlyph health={a.health} />
                    <span className="truncate">
                      <span className="font-mono">{a.name}</span> <span className="text-fg-muted">{a.detail}</span>
                    </span>
                    {a.link ? (
                      <button
                        type="button"
                        onClick={() => scopeTo("gitops")}
                        className="focus-ring rounded-sm border-0 bg-transparent p-0 text-ui text-accent hover:text-fg"
                      >
                        View
                      </button>
                    ) : (
                      <span className={cn("font-mono", healthTone[a.health === "failed" ? "warning" : a.health])}>{a.fact}</span>
                    )}
                  </div>
                ))}
              </section>
            )}
            <CapacitySection ov={ov} metrics={cluster.metrics !== null} />
            <section className="flex flex-col gap-2">
              <div className="section-label">Connection</div>
              <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-2.5 gap-y-[5px] text-ui">
                <KV k="API server" v={<span className="selectable font-mono text-meta">{ov.apiServer}</span>} />
                <KV k="Latency" v={<span className="font-mono text-meta">{ov.latency.p50}ms p50{ov.latency.p95 !== null && ` · ${ov.latency.p95}ms p95`}</span>} />
                <KV k="Auth" v={<span className="font-mono text-meta">{ov.auth}</span>} />
                <KV k="Context" v={<span className="selectable font-mono text-meta break-all">{cluster.context}</span>} />
                <KV k="Watching" v={`${ov.watching.types} resource types · ${ov.watching.objects.toLocaleString()} objects cached`} />
              </dl>
            </section>
            <ComponentsSection ov={ov} />
          </Panel>
          <Panel value="capacity">
            <CapacitySection ov={ov} metrics={cluster.metrics !== null} />
            <p className="m-0 text-meta text-fg-muted">
              Requested is the sum of pod requests on schedulable nodes; allocatable excludes system reservations. Usage comes
              from metrics-server and is current only.
            </p>
          </Panel>
          <Panel value="components">
            <ComponentsSection ov={ov} />
          </Panel>
          <Panel value="events">
            <EmptyState title="Not available yet">The cluster Events view is not implemented in this build.</EmptyState>
          </Panel>
        </Tabs>
      )}
    </>
  );
}

function Panel({ value, children }: { value: string; children: ReactNode }) {
  return (
    <TabsContent value={value} className="focus-ring flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3.5 py-3">
      {children}
    </TabsContent>
  );
}

function Quick({
  icon,
  label,
  children,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="focus-ring flex flex-col gap-[3px] rounded-[7px] border border-line bg-transparent px-[9px] py-2 text-left text-ui text-fg hover:bg-surface-hover disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent [&_svg]:size-3.5"
    >
      <span className="flex items-center gap-1.5">
        {icon}
        {label}
      </span>
      <span className="flex items-center gap-1.5 font-mono text-ui">{children}</span>
    </button>
  );
}

function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{k}</dt>
      <dd className="m-0 min-w-0 text-fg">{v}</dd>
    </>
  );
}

function CapacitySection({ ov, metrics }: { ov: ClusterOverview; metrics: boolean }) {
  const row = (label: string, c: ClusterOverview["cpu"], unit: string) => (
    <div className="flex flex-col gap-1">
      <div className="flex items-center text-ui">
        <span className="flex-1">{label}</span>
        <span className="font-mono text-fg-secondary">
          {metrics && c.used !== null ? `used ${c.used} · ` : ""}requested {c.requested} / {c.allocatable} {unit}
        </span>
      </div>
      <CapacityBar used={metrics ? c.used : null} requested={c.requested} allocatable={c.allocatable} label={`${label} capacity`} />
    </div>
  );
  return (
    <section className="flex flex-col gap-2">
      <div className="section-label">Capacity · allocatable</div>
      {row("CPU", ov.cpu, "cores")}
      {row("Memory", ov.memoryGiB, "GiB")}
      <div className="flex gap-3 text-meta text-fg-muted">
        <span className="flex items-center gap-1.5">
          <i className="h-1.5 w-2.5 rounded-[1px] bg-accent" />
          used
        </span>
        <span className="flex items-center gap-1.5">
          <i className="h-1.5 w-2.5 rounded-[1px] bg-fg-muted opacity-45" />
          requested
        </span>
        {!metrics && <span>No usage data: metrics.k8s.io is not available</span>}
      </div>
    </section>
  );
}

function ComponentsSection({ ov }: { ov: ClusterOverview }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="section-label">Detected components</div>
      <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-2.5 gap-y-[5px] text-ui">
        {ov.components.map((c) => (
          <KV
            key={c.name}
            k={c.name}
            v={
              <span className={cn("flex items-center gap-1.5", c.health === "unknown" && "text-fg-secondary")}>
                <StatusGlyph health={c.health} />
                {c.text}
              </span>
            }
          />
        ))}
      </dl>
    </section>
  );
}
