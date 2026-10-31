import { Suspense, lazy, useEffect, useState } from "react";
import { ViewErrorBoundary } from "@/components/ViewErrorBoundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmationProvider } from "@/components/safety/ConfirmationDialog";
import { WindowToolbar } from "@/components/shell/WindowToolbar";
import { ClusterNavigation } from "@/components/shell/ClusterNavigation";
import { NavigationRail } from "@/components/shell/NavigationRail";
import { StatusBar } from "@/components/shell/StatusBar";
import { EmptyState } from "@/components/EmptyState";
import { PodsWorkspace } from "@/features/pods/PodsWorkspace";
import { DeploymentsWorkspace } from "@/features/deployments/DeploymentsWorkspace";
import { ClustersWorkspace } from "@/features/clusters/ClustersWorkspace";
import { NodesWorkspace } from "@/features/nodes/NodesWorkspace";
import { PortForwardHost } from "@/features/portforward/PortForward";
import { DebugHost } from "@/features/debug/DebugDialogs";
import { ProtectedContextBar } from "@/components/safety/ProtectedContextBar";

// xterm.js and Monaco only load when a Shell or YAML tab renders.
const ShellWorkspace = lazy(() => import("@/features/terminal/ShellWorkspace").then((m) => ({ default: m.ShellWorkspace })));
const YamlWorkspace = lazy(() => import("@/features/yaml/YamlWorkspace").then((m) => ({ default: m.YamlWorkspace })));
const CreateResourceWorkspace = lazy(() => import("@/features/resources/CreateResourceWorkspace").then((m) => ({ default: m.CreateResourceWorkspace })));
// Views that are not needed at start load when first opened: a smaller first bundle
// parses faster. Pods, Clusters, Nodes and Deployments, the starting views, stay in it.
const InvestigationWorkspace = lazy(() => import("@/features/investigation/InvestigationWorkspace").then((m) => ({ default: m.InvestigationWorkspace })));
const CompareWorkspace = lazy(() => import("@/features/compare/CompareWorkspace").then((m) => ({ default: m.CompareWorkspace })));
const HelmWorkspace = lazy(() => import("@/features/helm/HelmWorkspace").then((m) => ({ default: m.HelmWorkspace })));
const GitOpsWorkspace = lazy(() => import("@/features/gitops/GitOpsWorkspace").then((m) => ({ default: m.GitOpsWorkspace })));
const ConnectionsWorkspace = lazy(() => import("@/features/connections/ConnectionsWorkspace").then((m) => ({ default: m.ConnectionsWorkspace })));
const SettingsWorkspace = lazy(() => import("@/features/settings/SettingsWorkspace").then((m) => ({ default: m.SettingsWorkspace })));
const LogsWorkspace = lazy(() => import("@/features/logs/LogsWorkspace").then((m) => ({ default: m.LogsWorkspace })));
const ResourceListWorkspace = lazy(() => import("@/features/resources/ResourceListWorkspace").then((m) => ({ default: m.ResourceListWorkspace })));
const ResourceDetailWorkspace = lazy(() => import("@/features/resources/ResourceDetailWorkspace").then((m) => ({ default: m.ResourceDetailWorkspace })));
const WarningsWorkspace = lazy(() => import("@/features/insights/WarningsWorkspace").then((m) => ({ default: m.WarningsWorkspace })));
const CertificatesWorkspace = lazy(() => import("@/features/insights/CertificatesWorkspace").then((m) => ({ default: m.CertificatesWorkspace })));
const AccessWorkspace = lazy(() => import("@/features/insights/AccessWorkspace").then((m) => ({ default: m.AccessWorkspace })));
const HelmUpgradeWorkspace = lazy(() => import("@/features/helm/HelmUpgradeWorkspace").then((m) => ({ default: m.HelmUpgradeWorkspace })));
const StorageWorkspace = lazy(() => import("@/features/storage/StorageWorkspace").then((m) => ({ default: m.StorageWorkspace })));
const NetworkWorkspace = lazy(() => import("@/features/network/NetworkWorkspace").then((m) => ({ default: m.NetworkWorkspace })));
const ServiceChainWorkspace = lazy(() => import("@/features/chain/ServiceChainWorkspace").then((m) => ({ default: m.ServiceChainWorkspace })));
const DiagnosticsPanel = lazy(() => import("@/features/bench/DiagnosticsPanel").then((m) => ({ default: m.DiagnosticsPanel })));
const SetupFlow = lazy(() => import("@/features/setup/SetupFlow").then((m) => ({ default: m.SetupFlow })));
const SetupTips = lazy(() => import("@/features/setup/SetupTips").then((m) => ({ default: m.SetupTips })));
import { usePersistentState } from "@/app/preferences";
import { WorkspaceProvider, useWorkspace, type WorkspaceTab } from "./workspace";
import { ShortcutsProvider } from "./shortcuts";
import { useBackendSync } from "./backendSync";
import { backend } from "@/backend/client";
import { t } from "@/i18n";
import type { SetupSummary } from "@/features/setup/SetupFlow";
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
                <Suspense fallback={null}>
                  <SetupFlow
                    onDone={(s) => {
                      setSummary(s);
                      setSetup("done");
                    }}
                    onSkip={() => setSetup("done")}
                  />
                </Suspense>
              ) : setup === "done" ? (
                <AppShell setupSummary={summary} onSetupTipsClosed={() => setSummary(null)} />
              ) : null}
              <PortForwardHost />
              <DebugHost />
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
        // The overlay draws every frame (its FPS meter): the idle scenario runs without it.
        setDiagnostics(cfg.scenario !== "idle");
        setTimeout(() => void import("@/features/bench/runner").then(({ runBenchmark }) => runBenchmark(cfg, () => ws.openTab("pods") || ws.openView({ kind: "pods", title: t("Pods") }))), 500);
      });
    }
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const scopedCluster = activeTab?.cluster ? clusterById(activeTab.cluster) : undefined;
  // Single-cluster workspaces and investigations need the width: the sidebar collapses to a rail.
  // Investigations, single-cluster lists and tool tabs (Logs, Shell, YAML, Compare) need the width.
  const railNav =
    ["investigation", "logs", "shell", "yaml", "compare", "helm-upgrade", "connections", "settings"].includes(activeTab?.kind ?? "") ||
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
      {setupSummary && (
        <Suspense fallback={null}>
          <SetupTips summary={setupSummary} onClose={onSetupTipsClosed} />
        </Suspense>
      )}
      {/* The protected band belongs to single-cluster lists; tool tabs carry their own context. */}
      {scopedCluster?.protected && activeTab?.kind === "deployments" && <ProtectedContextBar cluster={scopedCluster} />}
      <div className="flex min-h-0 flex-1">
        {railNav ? <NavigationRail /> : <ClusterNavigation />}
        {/* Inactive tabs stay mounted so filters, sort, scroll and selection survive tab switches. */}
        {tabs.map((tab) => (
          <div key={tab.id} role="tabpanel" hidden={tab.id !== activeTabId} className="min-w-0 flex-1 flex-col [&:not([hidden])]:flex">
            <ViewErrorBoundary label={`${tab.kind} tab`}>
              <Suspense fallback={<EmptyState className="flex-1" title={t("Loading…")} />}>
                <TabContent tab={tab} active={tab.id === activeTabId} />
              </Suspense>
            </ViewErrorBoundary>
          </div>
        ))}
      </div>
      <StatusBar />
      {diagnostics && backend && (
        <Suspense fallback={null}>
          <DiagnosticsPanel onClose={() => setDiagnostics(false)} />
        </Suspense>
      )}
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
    case "warnings":
      return <WarningsWorkspace active={active} />;
    case "certificates":
      return <CertificatesWorkspace active={active} />;
    case "access":
      return <AccessWorkspace active={active} />;
    case "helm-upgrade":
      return <HelmUpgradeWorkspace tab={tab} active={active} />;
    case "storage":
      return <StorageWorkspace active={active} />;
    case "network":
      return <NetworkWorkspace tab={tab} active={active} />;
    case "chain":
      return <ServiceChainWorkspace tab={tab} active={active} />;
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
