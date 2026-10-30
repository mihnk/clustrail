import { useEffect } from "react";
import { Layers } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmationProvider } from "@/components/safety/ConfirmationDialog";
import { WindowToolbar } from "@/components/shell/WindowToolbar";
import { ClusterNavigation } from "@/components/shell/ClusterNavigation";
import { NavigationRail } from "@/components/shell/NavigationRail";
import { StatusBar } from "@/components/shell/StatusBar";
import { EmptyState } from "@/components/EmptyState";
import { PodsWorkspace } from "@/features/pods/PodsWorkspace";
import { InvestigationWorkspace } from "@/features/investigation/InvestigationWorkspace";
import { DeploymentsWorkspace } from "@/features/deployments/DeploymentsWorkspace";
import { ProtectedContextBar } from "@/components/safety/ProtectedContextBar";
import { WorkspaceProvider, useWorkspace, type WorkspaceTab } from "./workspace";
import { ShortcutsProvider } from "./shortcuts";

export function App() {
  return (
    <ToastProvider>
      <WorkspaceProvider>
        <TooltipProvider delayDuration={400}>
          <ConfirmationProvider>
            <ShortcutsProvider>
              <AppShell />
            </ShortcutsProvider>
          </ConfirmationProvider>
        </TooltipProvider>
      </WorkspaceProvider>
    </ToastProvider>
  );
}

function AppShell() {
  const { theme, density, tabs, activeTabId, activeTab, clusterById } = useWorkspace();
  const scopedCluster = activeTab?.cluster ? clusterById(activeTab.cluster) : undefined;
  // Single-cluster workspaces and investigations need the width: the sidebar collapses to a rail.
  const railNav = activeTab?.kind === "investigation" || activeTab?.kind === "deployments";

  // Theme and density are document-level so portals (menus, tooltips) match.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("theme-dark", "theme-light", "density-compact", "density-comfortable");
    root.classList.add(`theme-${theme}`);
    if (density !== "default") root.classList.add(`density-${density}`);
  }, [theme, density]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-app text-fg">
      <WindowToolbar />
      {scopedCluster?.protected && <ProtectedContextBar cluster={scopedCluster} />}
      <div className="flex min-h-0 flex-1">
        {railNav ? <NavigationRail /> : <ClusterNavigation />}
        {/* Inactive tabs stay mounted so filters, sort, scroll and selection survive tab switches. */}
        {tabs.map((tab) => (
          <div key={tab.id} role="tabpanel" hidden={tab.id !== activeTabId} className="min-w-0 flex-1 flex-col [&:not([hidden])]:flex">
            <TabContent tab={tab} active={tab.id === activeTabId} />
          </div>
        ))}
      </div>
      <StatusBar />
    </div>
  );
}

function TabContent({ tab, active }: { tab: WorkspaceTab; active: boolean }) {
  switch (tab.kind) {
    case "pods":
      return <PodsWorkspace active={active} />;
    case "resource":
      return (
        <EmptyState className="flex-1" icon={<Layers />} title={`${tab.title} · ${tab.subtitle}`}>
          Resource detail views are not implemented in this build.
        </EmptyState>
      );
    case "investigation":
      return <InvestigationWorkspace />;
    case "deployments":
      return <DeploymentsWorkspace cluster={tab.cluster ?? ""} namespace={tab.params?.namespace ?? ""} />;
    default:
      return (
        <EmptyState className="flex-1" title={tab.title}>
          This view is not implemented in this build.
        </EmptyState>
      );
  }
}
