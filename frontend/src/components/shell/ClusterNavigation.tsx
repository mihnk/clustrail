import type { ReactNode } from "react";
import {
  Activity,
  Box,
  FileText,
  GitBranch,
  Globe,
  LayoutGrid,
  Layers,
  LifeBuoy,
  Lock,
  Network,
  Pin,
  Plus,
  Server,
} from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import type { Environment } from "@/data/types";
import { isAttention } from "@/data/health";
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
  const { pods } = useWorkspace();
  const attention = pods.filter((p) => isAttention(p.health)).length;

  return (
    <aside
      aria-label="Navigation"
      className="flex w-[220px] shrink-0 flex-col gap-3.5 overflow-y-auto border-r border-line bg-surface-side px-2 py-2.5"
    >
      <ClusterList />

      <NavSection title={<><span className="section-label">Resources</span><Pin className="size-3.5 text-fg-muted" aria-label="Pinned" /></>}>
        <NavItem icon={<Box />} label="Pods" active trailing={<>{attention > 0 && <CountPill tone="critical" className="ml-auto">{attention}</CountPill>}<NavCount className={attention > 0 ? "ml-1.5" : ""}>{pods.length}</NavCount></>} />
        <NavItem icon={<Layers />} label="Deployments" trailing={<><CountPill tone="warning" className="ml-auto">2</CountPill><NavCount className="ml-1.5">86</NavCount></>} />
        <NavItem icon={<Network />} label="Services" trailing={<NavCount>74</NavCount>} />
        <NavItem icon={<Globe />} label="Ingresses" trailing={<NavCount>19</NavCount>} />
        <NavItem icon={<FileText />} label="ConfigMaps" trailing={<NavCount>203</NavCount>} />
        <NavItem icon={<Activity />} label="Events" trailing={<CountPill tone="warning" className="ml-auto">23</CountPill>} />
        <NavItem icon={<Server />} label="Nodes" trailing={<NavCount>38</NavCount>} />
        <NavItem icon={<LayoutGrid />} label="All resource kinds" muted trailing={<Kbd className="ml-auto">{modKey}J</Kbd>} />
      </NavSection>

      <NavSection title={<span className="section-label">Investigations</span>}>
        <NavItem icon={<StatusGlyph health="failed" />} label="checkout-api restarts" trailing={<NavCount>12m</NavCount>} />
        <NavItem icon={<Plus />} label="New investigation" muted />
      </NavSection>

      <NavSection title={<span className="section-label">Delivery</span>}>
        <NavItem icon={<LifeBuoy />} label="Helm releases" trailing={<NavCount>31</NavCount>} />
        <NavItem icon={<GitBranch />} label="GitOps" trailing={<CountPill tone="warning" className="ml-auto">2 drift</CountPill>} />
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
}: {
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  active?: boolean;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(
        "focus-ring flex h-7 w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-body leading-none text-fg-secondary hover:bg-surface-hover [&>svg]:size-4 [&>svg]:shrink-0",
        active && "bg-surface-hover font-medium text-fg",
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
