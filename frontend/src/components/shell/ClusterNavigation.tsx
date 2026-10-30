import type { ReactNode } from "react";
import {
  Activity,
  Box,
  Clock,
  Copy,
  Database,
  FileText,
  GitBranch,
  Globe,
  LayoutGrid,
  Layers,
  LifeBuoy,
  Lock,
  Network,
  Pin,
  Play,
  Plus,
  Route,
  Server,
} from "lucide-react";
import { DEFAULT_INVESTIGATION, useWorkspace } from "@/app/workspace";
import { useOverlays } from "@/app/shortcuts";
import { LISTED_KINDS } from "@/features/resources/kinds";
import type { Environment } from "@/data/types";
import { isAttention } from "@/data/health";
import { IS_MOCK } from "@/data/mock";
import { Checkbox } from "@/components/ui/checkbox";
import { Kbd } from "@/components/ui/kbd";
import { ConnectionDot, EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { CountPill } from "@/components/status/ResourceStatus";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { cn } from "@/lib/cn";
import { modKey } from "@/lib/platform";

const envGroups: { env: Environment; label: string }[] = [
  { env: "prod", label: "Production" },
  { env: "stg", label: "Staging" },
  { env: "dev", label: "Development" },
];

export function ClusterNavigation() {
  const { pods, activeTab, openTab, openView, clusters, pins, deployments, nodes, helmReleases, gitops, selectedClusterIds, investigations, currentInvestigation, openInvestigation, newInvestigation } =
    useWorkspace();
  const kind = activeTab?.kind;
  const { openKinds } = useOverlays();
  const listKind = kind === "list" ? activeTab?.params?.kind : undefined;
  const list = (key: string, icon: ReactNode, mockCount?: ReactNode) => {
    const label = LISTED_KINDS.find((k) => k.key === key)!.label;
    return (
      <NavItem
        key={key}
        icon={icon}
        label={label}
        active={listKind === key}
        onClick={() => openView({ kind: "list", title: label, params: { kind: key } })}
        trailing={real ? undefined : mockCount}
      />
    );
  };
  const attention = pods.filter((p) => isAttention(p.health)).length;
  // Mock: the design's numbers. Desktop: counts over the selected clusters; kinds Clustrail does not list yet show none.
  const inSel = <T extends { cluster: string }>(rows: T[]) => rows.filter((r) => selectedClusterIds.includes(r.cluster));
  const real = !IS_MOCK;
  const deps = inSel(deployments);
  const depsAttention = deps.filter((d) => isAttention(d.health)).length;
  const nodeRows = inSel(nodes);
  const nodesAttention = nodeRows.filter((n) => n.health === "failed" || n.health === "warning").length;
  const releases = inSel(helmReleases);
  const releasesFailed = releases.filter((r) => r.health === "failed").length;
  const drift = inSel(gitops).filter((g) => g.sync === "OutOfSync").length;
  const count = (attentionN: number, total: number, tone: "critical" | "warning") => (
    <>
      {attentionN > 0 && <CountPill tone={tone} className="ml-auto">{attentionN}</CountPill>}
      <NavCount className={attentionN > 0 ? "ml-1.5" : ""}>{total}</NavCount>
    </>
  );

  return (
    <aside
      aria-label="Navigation"
      className="flex w-[220px] shrink-0 flex-col gap-3.5 overflow-y-auto border-r border-line bg-surface-side px-2 py-2.5 max-[1360px]:w-[196px]"
    >
      <ClusterList />

      <NavSection title={<><span className="section-label">Resources</span><Pin className="size-3.5 text-fg-muted" aria-label="Pinned" /></>}>
        <NavItem icon={<Network />} label="Overview" active={kind === "clusters"} onClick={() => openView({ kind: "clusters", title: "Clusters" })} trailing={<NavCount>{clusters.length}</NavCount>} />
        <NavItem icon={<Box />} label="Pods" active={kind === "pods"} onClick={() => openTab("pods")} trailing={<>{attention > 0 && <CountPill tone="critical" className="ml-auto">{attention}</CountPill>}<NavCount className={attention > 0 ? "ml-1.5" : ""}>{pods.length}</NavCount></>} />
        <NavItem icon={<Layers />} label="Deployments" active={kind === "deployments"} onClick={() => openView({ kind: "deployments", title: "Deployments" })} trailing={real ? count(depsAttention, deps.length, "warning") : <><CountPill tone="warning" className="ml-auto">2</CountPill><NavCount className="ml-1.5">86</NavCount></>} />
        {real && (
          <>
            {list("apps/StatefulSet", <Database />)}
            {list("apps/DaemonSet", <Copy />)}
            {list("batch/Job", <Play />)}
            {list("batch/CronJob", <Clock />)}
          </>
        )}
        {list("Service", <Network />, <NavCount>74</NavCount>)}
        {list("networking.k8s.io/Ingress", <Globe />, <NavCount>19</NavCount>)}
        {list("ConfigMap", <FileText />, <NavCount>203</NavCount>)}
        {list("Event", <Activity />, <CountPill tone="warning" className="ml-auto">23</CountPill>)}
        <NavItem icon={<Server />} label="Nodes" active={kind === "nodes"} onClick={() => openView({ kind: "nodes", title: "Nodes" })} trailing={real ? count(nodesAttention, nodeRows.length, "warning") : <><CountPill tone="warning" className="ml-auto">1</CountPill><NavCount className="ml-1.5">38</NavCount></>} />
        <NavItem icon={<LayoutGrid />} label="All resource kinds" onClick={openKinds} trailing={<Kbd className="ml-auto">{modKey}J</Kbd>} />
      </NavSection>

      <NavSection title={<span className="section-label">Investigations</span>}>
        {investigations.map((inv) =>
          IS_MOCK && inv.id === DEFAULT_INVESTIGATION ? (
            <NavItem key={inv.id} icon={<StatusGlyph health="failed" />} label={inv.title} active={activeTab?.id === inv.id} onClick={() => openTab(inv.id) || openInvestigation(inv.id)} trailing={<NavCount>12m</NavCount>} />
          ) : (
            <NavItem
              key={inv.id}
              icon={<Route />}
              label={inv.title}
              active={activeTab?.id === inv.id}
              onClick={() => openInvestigation(inv.id)}
              trailing={inv.id === currentInvestigation ? <NavCount className="flex items-center gap-0.5">{pins.length} <Pin className="size-3" aria-label="New pins land here" /></NavCount> : undefined}
            />
          ),
        )}
        <NavItem icon={<Plus />} label="New investigation" onClick={newInvestigation} />
      </NavSection>

      <NavSection title={<span className="section-label">Delivery</span>}>
        <NavItem icon={<LifeBuoy />} label="Helm releases" active={kind === "helm"} onClick={() => openView({ kind: "helm", title: "Helm releases" })} trailing={real ? count(releasesFailed, releases.length, "critical") : <><CountPill tone="critical" className="ml-auto">1</CountPill><NavCount className="ml-1.5">31</NavCount></>} />
        <NavItem icon={<GitBranch />} label="GitOps" active={kind === "gitops"} onClick={() => openView({ kind: "gitops", title: "GitOps" })} trailing={real ? (drift > 0 ? <CountPill tone="warning" className="ml-auto">{drift} drift</CountPill> : undefined) : <CountPill tone="warning" className="ml-auto">2 drift</CountPill>} />
      </NavSection>
    </aside>
  );
}

function ClusterList() {
  const { clusters, selectedClusterIds, toggleCluster } = useWorkspace();
  const selected = new Set(selectedClusterIds);
  return (
    <section aria-label="Clusters" className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="section-label">Clusters</span>
        <span className="font-mono text-label text-fg-muted">
          {selected.size} of {clusters.length}
        </span>
      </div>
      {envGroups.map(({ env, label }, i) => {
        const group = clusters.filter((c) => c.env === env);
        if (group.length === 0) return null;
        const anyProtected = group.some((c) => c.protected);
        return (
          <div key={env} className="flex flex-col gap-0.5">
            <div className={cn("flex items-center gap-1.5 px-2 pb-0.5 text-meta text-fg-muted", i === 0 ? "pt-1" : "pt-2")}>
              <EnvironmentBadge env={env} />
              <span className="flex-1">{label}</span>
              {anyProtected && <Lock className="size-3.5 text-env-prod-ink" aria-label="Protected" />}
            </div>
            {group.map((c) => {
              const on = selected.has(c.id);
              return (
                <label
                  key={c.id}
                  className={cn(
                    "flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-cell hover:bg-surface-hover",
                    on ? "text-fg" : "text-fg-secondary",
                  )}
                >
                  <Checkbox checked={on} onCheckedChange={(v) => toggleCluster(c.id, v)} aria-label={`Include ${c.name}`} />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <ConnectionDot state={c.connection} />
                </label>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}

function NavSection({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-px">
      <div className="flex items-center justify-between px-2 pb-1">{title}</div>
      {children}
    </section>
  );
}

function NavItem({
  icon,
  label,
  trailing,
  active,
  muted,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  active?: boolean;
  muted?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "focus-ring flex h-7 w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-body leading-none text-fg-secondary hover:bg-surface-hover [&>svg]:size-4 [&>svg]:shrink-0",
        active && "bg-surface-panel font-medium text-fg shadow-[0_0_0_1px_var(--line)] dark:bg-surface-hover dark:shadow-none",
        muted && "text-fg-muted",
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      {trailing}
    </button>
  );
}

function NavCount({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("ml-auto font-mono text-meta text-fg-muted", className)}>{children}</span>;
}
