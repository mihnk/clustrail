import { Suspense, lazy, useEffect } from "react";
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
import { CompareWorkspace } from "@/features/compare/CompareWorkspace";
import { HelmWorkspace } from "@/features/helm/HelmWorkspace";
import { GitOpsWorkspace } from "@/features/gitops/GitOpsWorkspace";
import { ConnectionsWorkspace } from "@/features/connections/ConnectionsWorkspace";
import { SettingsWorkspace } from "@/features/settings/SettingsWorkspace";
import { DeploymentsWorkspace } from "@/features/deployments/DeploymentsWorkspace";
import { ClustersWorkspace } from "@/features/clusters/ClustersWorkspace";
import { NodesWorkspace } from "@/features/nodes/NodesWorkspace";
import { LogsWorkspace } from "@/features/logs/LogsWorkspace";
import { ResourceListWorkspace } from "@/features/resources/ResourceListWorkspace";
import { ProtectedContextBar } from "@/components/safety/ProtectedContextBar";

// xterm.js and Monaco only load when a Shell or YAML tab renders.
const ShellWorkspace = lazy(() => import("@/features/terminal/ShellWorkspace").then((m) => ({ default: m.ShellWorkspace })));
const YamlWorkspace = lazy(() => import("@/features/yaml/YamlWorkspace").then((m) => ({ default: m.YamlWorkspace })));
const CreateResourceWorkspace = lazy(() => import("@/features/resources/CreateResourceWorkspace").then((m) => ({ default: m.CreateResourceWorkspace })));
import { usePersistentState } from "@/app/preferences";
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
  // Investigations, single-cluster lists and tool tabs (Logs, Shell, YAML, Compare) need the width.
  const railNav =
    ["investigation", "logs", "shell", "yaml", "compare", "connections", "settings"].includes(activeTab?.kind ?? "") ||
    (activeTab?.kind === "deployments" && !!activeTab.cluster);

  const [fontSize] = usePersistentState("settings.fontSize", 13);
  const [reduceMotion] = usePersistentState("settings.reduceMotion", false);

  // Theme and density are document-level so portals (menus, tooltips) match.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("theme-dark", "theme-light", "density-compact", "density-comfortable");
    root.classList.add(`theme-${theme}`);
    if (density !== "default") root.classList.add(`density-${density}`);
    root.classList.toggle("reduce-motion", reduceMotion);
    // Type sizes are tokens in px; the interface size scales the whole document from the 13px base.
    root.style.zoom = fontSize === 13 ? "" : String(fontSize / 13);
  }, [theme, density, reduceMotion, fontSize]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-app text-fg">
      <WindowToolbar />
      {/* The protected band belongs to single-cluster lists; tool tabs carry their own context. */}
      {scopedCluster?.protected && activeTab?.kind === "deployments" && <ProtectedContextBar cluster={scopedCluster} />}
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
    case "clusters":
      return <ClustersWorkspace active={active} />;
    case "nodes":
      return <NodesWorkspace active={active} />;
    case "logs":
      return <LogsWorkspace tab={tab} active={active} />;
    case "shell":
      return (
        <Suspense fallback={<EmptyState className="flex-1" title="Loading terminal…" />}>
          <ShellWorkspace tab={tab} active={active} />
        </Suspense>
      );
    case "yaml":
      return (
        <Suspense fallback={<EmptyState className="flex-1" title="Loading editor…" />}>
          <YamlWorkspace tab={tab} active={active} />
        </Suspense>
      );
    case "resource":
      return (
        <EmptyState className="flex-1" icon={<Layers />} title={`${tab.title} · ${tab.subtitle}`}>
          Resource detail views are not implemented in this build.
        </EmptyState>
      );
    case "list":
      return <ResourceListWorkspace tab={tab} active={active} />;
    case "create":
      return (
        <Suspense fallback={<EmptyState className="flex-1" title="Loading editor…" />}>
          <CreateResourceWorkspace tab={tab} active={active} />
        </Suspense>
      );
    case "investigation":
      return <InvestigationWorkspace />;
    case "compare":
      return <CompareWorkspace tab={tab} active={active} />;
    case "helm":
      return <HelmWorkspace active={active} />;
    case "gitops":
      return <GitOpsWorkspace active={active} />;
    case "connections":
      return <ConnectionsWorkspace active={active} />;
    case "settings":
      return <SettingsWorkspace active={active} />;
    case "deployments":
      return <DeploymentsWorkspace cluster={tab.cluster ?? ""} namespace={tab.params?.namespace ?? ""} active={active} />;
    default:
      return (
        <EmptyState className="flex-1" title={tab.title}>
          This view is not implemented in this build.
        </EmptyState>
      );
  }
}
