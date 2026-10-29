import { useEffect } from "react";
import { Layers } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmationProvider } from "@/components/safety/ConfirmationDialog";
import { WindowToolbar } from "@/components/shell/WindowToolbar";
import { ClusterNavigation } from "@/components/shell/ClusterNavigation";
import { StatusBar } from "@/components/shell/StatusBar";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { EmptyState } from "@/components/EmptyState";
import { PodsWorkspace } from "@/features/pods/PodsWorkspace";
import { WorkspaceProvider, useWorkspace, type WorkspaceTab } from "./workspace";

export function App() {
  return (
    <WorkspaceProvider>
      <TooltipProvider delayDuration={400}>
        <ConfirmationProvider>
          <AppShell />
        </ConfirmationProvider>
      </TooltipProvider>
    </WorkspaceProvider>
  );
}

function AppShell() {
  const { theme, density, tabs, activeTabId } = useWorkspace();

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
      <div className="flex min-h-0 flex-1">
        <ClusterNavigation />
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
      return (
        <EmptyState className="flex-1" icon={<StatusGlyph health="failed" className="size-5" />} title={tab.title}>
          The investigation workspace is not implemented in this build.
        </EmptyState>
      );
  }
}
