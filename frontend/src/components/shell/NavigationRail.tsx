import type { ReactNode } from "react";
import { Activity, Box, GitBranch, LayoutGrid, Layers, LifeBuoy, Network, Route, Server } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { useOverlays } from "@/app/shortcuts";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

/**
 * Collapsed navigation for workspaces that need the width (investigations,
 * narrow windows). Same destinations as the sidebar, icon-only with tooltips.
 */
export function NavigationRail() {
  const { selectedClusterIds, activeTab, openTab, openView } = useWorkspace();
  const { openKinds } = useOverlays();
  const listKind = activeTab?.kind === "list" ? activeTab.params?.kind : undefined;
  const kind = activeTab?.kind;
  return (
    <nav
      aria-label="Navigation (collapsed)"
      className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-line bg-surface-side py-2.5"
    >
      <RailButton
        label={`Clusters: ${selectedClusterIds.length} selected`}
        active={kind === "clusters"}
        onClick={() => openView({ kind: "clusters", title: "Clusters" })}
      >
        <span className="font-mono text-label font-semibold text-fg-secondary">{selectedClusterIds.length}</span>
      </RailButton>
      <Divider />
      <RailButton label="Pods" active={kind === "pods"} onClick={() => openTab("pods")}>
        <Box />
      </RailButton>
      <RailButton label="Deployments" active={kind === "deployments"} onClick={() => openView({ kind: "deployments", title: "Deployments" })}>
        <Layers />
      </RailButton>
      <RailButton label="Services" active={listKind === "Service"} onClick={() => openView({ kind: "list", title: "Services", params: { kind: "Service" } })}>
        <Network />
      </RailButton>
      <RailButton label="Events" active={listKind === "Event"} onClick={() => openView({ kind: "list", title: "Events", params: { kind: "Event" } })}>
        <Activity />
      </RailButton>
      <RailButton label="Nodes" active={kind === "nodes"} onClick={() => openView({ kind: "nodes", title: "Nodes" })}>
        <Server />
      </RailButton>
      <RailButton label="All resource kinds" onClick={openKinds}>
        <LayoutGrid />
      </RailButton>
      <Divider />
      <RailButton label="Investigations" active={kind === "investigation"} onClick={() => openTab("inv-checkout-api") || openView({ id: "inv-checkout-api", kind: "investigation", title: "Investigation" })}>
        <Route />
      </RailButton>
      <RailButton label="Helm releases" active={kind === "helm"} onClick={() => openView({ kind: "helm", title: "Helm releases" })}>
        <LifeBuoy />
      </RailButton>
      <RailButton label="GitOps" active={kind === "gitops"} onClick={() => openView({ kind: "gitops", title: "GitOps" })}>
        <GitBranch />
      </RailButton>
    </nav>
  );
}

function Divider() {
  return <div className="my-1 w-6 border-t border-line" role="presentation" />;
}

function RailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label} side="right">
      <button
        type="button"
        aria-label={label}
        aria-current={active ? "page" : undefined}
        onClick={onClick}
        className={cn(
          "focus-ring flex size-9 items-center justify-center rounded-lg border-0 bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg [&_svg]:size-4",
          active && "bg-surface-hover text-fg",
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}
