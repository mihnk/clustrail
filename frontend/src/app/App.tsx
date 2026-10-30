import { Suspense, lazy, useEffect, useState } from "react";
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
import { ResourceDetailWorkspace } from "@/features/resources/ResourceDetailWorkspace";
import { PortForwardHost } from "@/features/portforward/PortForward";
import { ProtectedContextBar } from "@/components/safety/ProtectedContextBar";

// xterm.js and Monaco only load when a Shell or YAML tab renders.
const ShellWorkspace = lazy(() => import("@/features/terminal/ShellWorkspace").then((m) => ({ default: m.ShellWorkspace })));
const YamlWorkspace = lazy(() => import("@/features/yaml/YamlWorkspace").then((m) => ({ default: m.YamlWorkspace })));
const CreateResourceWorkspace = lazy(() => import("@/features/resources/CreateResourceWorkspace").then((m) => ({ default: m.CreateResourceWorkspace })));
import { usePersistentState } from "@/app/preferences";
import { WorkspaceProvider, useWorkspace, type WorkspaceTab } from "./workspace";
import { ShortcutsProvider } from "./shortcuts";
import { useBackendSync } from "./backendSync";
import { backend } from "@/backend/client";
import { DiagnosticsPanel } from "@/features/bench/DiagnosticsPanel";
import { runBenchmark } from "@/features/bench/runner";
import { t } from "@/i18n";
import { SetupFlow, type SetupSummary } from "@/features/setup/SetupFlow";
import { SetupTips } from "@/features/setup/SetupTips";
import { SETUP_EVENT } from "@/features/setup/api";

export function App() {
  // First-run setup comes before the workspace: the Go side says whether it is due.
  const [setup, setSetup] = useState<"checking" | "needed" | "done">(backend ? "checking" : "done");
  const [summary, setSummary] = useState<SetupSummary | null>(null);
  useEffect(() => {
    if (backend) {
      backend.setup().then(
        (info) => setSetup(info?.needed ? "needed" : "done"),
        () => setSetup("done"),
      );
    }
    const open = () => setSetup("needed");
    window.addEventListener(SETUP_EVENT, open);
    return () => window.removeEventListener(SETUP_EVENT, open);
  }, []);
  return (
    <ToastProvider>
      <WorkspaceProvider>
        <TooltipProvider delayDuration={400}>
          <ConfirmationProvider>
            <ShortcutsProvider>
              {setup === "needed" ? (
                <SetupFlow
                  onDone={(s) => {
                    setSummary(s);
                    setSetup("done");
                  }}
                  onSkip={() => setSetup("done")}
                />
              ) : setup === "done" ? (
                <AppShell setupSummary={summary} onSetupTipsClosed={() => setSummary(null)} />
              ) : null}
              <PortForwardHost />
            </ShortcutsProvider>
          </ConfirmationProvider>
        </TooltipProvider>
      </WorkspaceProvider>
    </ToastProvider>
  );
}

function AppShell({ setupSummary, onSetupTipsClosed }: { setupSummary: SetupSummary | null; onSetupTipsClosed: () => void }) {
  const ws = useWorkspace();
  // Right after setup: the overview of the clusters it connected.
  useEffect(() => {
    if (setupSummary) ws.openView({ kind: "clusters", title: t("Clusters") });
  }, [setupSummary]);
  const { theme, density, tabs, activeTabId, activeTab, clusterById } = ws;
  useBackendSync();
  // Development diagnostics (⌘⇧D) and the in-app benchmark runner (CLUSTRAIL_BENCH).
  const [diagnostics, setDiagnostics] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setDiagnostics((x) => !x);
      }
    };
    window.addEventListener("keydown", onKey);
    if (backend) {
      void backend.benchConfig().then((cfg) => {
        if (!cfg) return;
        setDiagnostics(true);
        setTimeout(() => void runBenchmark(cfg, () => ws.openTab("pods") || ws.openView({ kind: "pods", title: t("Pods") })), 500);
      });
    }
    return () => window.removeEventListener("keydown", onKey);
  }, []);
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
      {setupSummary && <SetupTips summary={setupSummary} onClose={onSetupTipsClosed} />}
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
      {diagnostics && backend && <DiagnosticsPanel onClose={() => setDiagnostics(false)} />}
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
        <Suspense fallback={<EmptyState className="flex-1" title={t("Loading terminal…")} />}>
          <ShellWorkspace tab={tab} active={active} />
        </Suspense>
      );
    case "yaml":
      return (
        <Suspense fallback={<EmptyState className="flex-1" title={t("Loading editor…")} />}>
          <YamlWorkspace tab={tab} active={active} />
        </Suspense>
      );
    case "resource":
      return <ResourceDetailWorkspace tab={tab} active={active} />;
    case "list":
      return <ResourceListWorkspace tab={tab} active={active} />;
    case "create":
      return (
        <Suspense fallback={<EmptyState className="flex-1" title={t("Loading editor…")} />}>
          <CreateResourceWorkspace tab={tab} active={active} />
        </Suspense>
      );
    case "investigation":
      return <InvestigationWorkspace tab={tab} />;
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
        <EmptyState className="flex-1" title={tab.title}>{t("This view is not implemented in this build.")}</EmptyState>
      );
  }
}
