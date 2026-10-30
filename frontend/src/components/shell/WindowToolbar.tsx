import { useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  Box,
  ChevronDown,
  Code,
  GitBranch,
  KeyRound,
  Layers,
  LifeBuoy,
  Network,
  Plus,
  ScrollText,
  Search,
  Server,
  Settings,
  SquareTerminal,
  X,
  TriangleAlert,
  FileBadge,
  ShieldCheck,
  ArrowUpCircle,
  HardDrive,
  Waypoints,
  Route,
} from "lucide-react";
import { IS_MOCK } from "@/data/mock";
import { Tooltip } from "@/components/ui/tooltip";
import { useWorkspace, type WorkspaceTab } from "@/app/workspace";
import type { Density, ThemePreference } from "@/app/preferences";
import { Button, IconButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { cn } from "@/lib/cn";
import { isMac, modKey } from "@/lib/platform";
import { Logo } from "./Logo";
import { useOverlays } from "@/app/shortcuts";
import { t as tt } from "@/i18n";

export function WindowToolbar() {
  const { openPalette } = useOverlays();
  return (
    <header
      className={cn(
        "drag-region flex h-10 shrink-0 items-center gap-3.5 border-b border-line bg-surface-side pr-2.5",
        isMac ? "pl-[78px]" : "pl-3.5",
      )}
    >
      <Logo />
      <WorkspaceTabs />
      <button
        type="button"
        onClick={openPalette}
        data-tour="palette"
        className="focus-ring no-drag flex h-7 w-[300px] items-center gap-1.5 rounded-md border border-line-strong bg-surface-panel pl-2 pr-1.5 text-cell text-fg-muted"
      >
        <Search className="size-3.5" aria-hidden />
        <span className="flex-1 text-left">{tt("Go to resource or run command…")}</span>
        <Kbd>{modKey}K</Kbd>
      </button>
      <SettingsMenu />
    </header>
  );
}

/**
 * Estimated width of a tab, for deciding what overflows: icon and padding,
 * title, environment badge, the secondary label (shown on the active tab, or
 * on every tab while there are few) and the close button.
 */
function tabWidth(tab: WorkspaceTab, active: boolean, compact: boolean, pods: string) {
  const secondary = tab.cluster ? tab.cluster.length * 6.6 + 8 : tab.kind === "pods" ? pods.length * 6.6 + 8 : tab.subtitle ? tab.subtitle.length * 6 + 8 : 0;
  return 44 + tab.title.length * 6.6 + (tab.cluster ? 44 : 0) + (active || !compact ? secondary : 0) + (active ? 24 : 0);
}

function WorkspaceTabs() {
  const { tabs, activeTabId, setActiveTabId, closeTab, selectedClusterIds, clusterById } = useWorkspace();
  const { openPalette } = useOverlays();
  const navRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Tabs shrink first (non-active tabs lose their secondary label), then
  // overflow into a list. The active tab is always shown; prod tabs keep their tag.
  const compact = tabs.length > 3;
  const podsLabel = tt(selectedClusterIds.length === 1 ? "1 cluster" : "{n} clusters", { n: selectedClusterIds.length });
  // Room for the "+N" overflow button and the new-tab button.
  const budget = width - 96;
  const widthOf = (t: WorkspaceTab) => tabWidth(t, t.id === activeTabId, compact, podsLabel) + 4;
  const visible: WorkspaceTab[] = [];
  let used = 0;
  for (const t of tabs) {
    const w = widthOf(t);
    if (used + w <= budget || width === 0) {
      visible.push(t);
      used += w;
    } else break;
  }
  const active = tabs.find((t) => t.id === activeTabId);
  if (active && !visible.includes(active)) {
    // Make room for the active tab by dropping tabs from the end.
    used += widthOf(active);
    while (visible.length && used > budget) used -= widthOf(visible.pop()!);
    visible.push(active);
  }
  const overflow = tabs.filter((t) => !visible.includes(t));

  return (
    <nav ref={navRef} aria-label={tt("Workspace tabs")} className="no-drag flex min-w-0 flex-1 items-center gap-1">
      <div role="tablist" className="flex min-w-0 items-center gap-1 overflow-hidden">
        {visible.map((tab) => {
          const isActive = tab.id === activeTabId;
          const secondary = tab.cluster ? (
            <span className="font-mono text-label text-fg-muted">{tab.cluster}</span>
          ) : tab.kind === "pods" ? (
            <span className="font-mono text-label text-fg-muted">
              {podsLabel}
            </span>
          ) : tab.subtitle ? (
            <span className="text-label text-fg-muted">{tab.subtitle}</span>
          ) : null;
          return (
            <div
              key={tab.id}
              onAuxClick={(e) => {
                // Middle-click closes, like a browser tab.
                if (e.button === 1 && tabs.length > 1) closeTab(tab.id);
              }}
              className={cn(
                // Estimates can be off by a few pixels: tabs shrink (title truncates) rather than overlap "+N".
                "flex h-7 min-w-[56px] shrink items-center rounded-md text-fg-secondary",
                isActive && "bg-surface-panel text-fg shadow-[inset_0_0_0_1px_var(--line-strong)] dark:bg-surface-hover",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                title={tab.cluster ? `${tab.title} · ${tab.cluster}` : tab.title}
                onClick={() => setActiveTabId(tab.id)}
                className={cn(
                  "focus-ring flex h-7 min-w-0 items-center gap-[7px] rounded-md bg-transparent pl-2.5 text-cell font-medium leading-none text-inherit",
                  isActive && tabs.length > 1 ? "pr-1" : "pr-2.5",
                )}
              >
                {tab.cluster && <EnvironmentBadge env={clusterById(tab.cluster)?.env ?? "dev"} size="sm" />}
                <TabIcon tab={tab} />
                <span className="truncate">{tab.title}</span>
                {(isActive || !compact) && secondary}
              </button>
              {isActive && tabs.length > 1 && (
                <IconButton aria-label={tt("Close {title}", { title: tab.title })} className="mr-1 size-[18px] [&_svg]:size-3" onClick={() => closeTab(tab.id)}>
                  <X />
                </IconButton>
              )}
            </div>
          );
        })}
      </div>
      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" aria-label={tt("{length} more tabs", { length: overflow.length })}>
              +{overflow.length}
              <ChevronDown aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {overflow.map((t) => (
              <DropdownMenuItem key={t.id} onSelect={() => setActiveTabId(t.id)}>
                {t.cluster && <EnvironmentBadge env={clusterById(t.cluster)?.env ?? "dev"} size="sm" />}
                <TabIcon tab={t} />
                <span className="truncate">{t.title}</span>
                {t.cluster && <span className="ml-auto font-mono text-label text-fg-muted">{t.cluster}</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Tooltip content={`New tab: open anything from the command palette (${modKey}K)`}>
        <IconButton aria-label={tt("New tab")} onClick={openPalette}>
          <Plus className="!size-3.5" />
        </IconButton>
      </Tooltip>
    </nav>
  );
}

function TabIcon({ tab }: { tab: WorkspaceTab }) {
  const cls = "size-3.5 shrink-0";
  switch (tab.kind) {
    case "clusters":
      return <Network className={cls} aria-hidden />;
    case "pods":
      return <Box className={cls} aria-hidden />;
    case "resource":
    case "deployments":
      return <Layers className={cls} aria-hidden />;
    case "nodes":
      return <Server className={cls} aria-hidden />;
    case "investigation":
      return <StatusGlyph health="failed" />;
    case "logs":
      return <ScrollText className={cls} aria-hidden />;
    case "shell":
      return <SquareTerminal className={cls} aria-hidden />;
    case "yaml":
      return <Code className={cls} aria-hidden />;
    case "compare":
      return <ArrowLeftRight className={cls} aria-hidden />;
    case "helm":
      return <LifeBuoy className={cls} aria-hidden />;
    case "gitops":
      return <GitBranch className={cls} aria-hidden />;
    case "warnings":
      return <TriangleAlert className={cls} aria-hidden />;
    case "certificates":
      return <FileBadge className={cls} aria-hidden />;
    case "access":
      return <ShieldCheck className={cls} aria-hidden />;
    case "helm-upgrade":
      return <ArrowUpCircle className={cls} aria-hidden />;
    case "storage":
      return <HardDrive className={cls} aria-hidden />;
    case "network":
      return <Waypoints className={cls} aria-hidden />;
    case "chain":
      return <Route className={cls} aria-hidden />;
    case "connections":
      return <KeyRound className={cls} aria-hidden />;
    case "settings":
      return <Settings className={cls} aria-hidden />;
  }
}

function SettingsMenu() {
  const { themePreference, setTheme, density, setDensity, openView, scenarios, setScenario, simulateSlowList } = useWorkspace();
  const { openHelp } = useOverlays();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton aria-label={tt("Settings")}>
          <Settings />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{tt("Theme")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={themePreference} onValueChange={(v) => setTheme(v as ThemePreference)}>
          <DropdownMenuRadioItem value="system">{tt("System")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">{tt("Dark")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">{tt("Light")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{tt("Table density")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={density} onValueChange={(v) => setDensity(v as Density)}>
          <DropdownMenuRadioItem value="compact">{tt("Compact · 24px")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="default">{tt("Default · 28px")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="comfortable">{tt("Comfortable · 34px")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openView({ kind: "settings", title: "Settings" })}>
          <Settings aria-hidden />{tt("All settings…")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={openHelp}>{tt("Keyboard shortcuts")}<span className="ml-auto font-mono text-label text-fg-muted">?</span>
        </DropdownMenuItem>
        {IS_MOCK && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{tt("Mock scenarios")}</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={scenarios.watchLost}
              onCheckedChange={(on) => setScenario("watchLost", on)}
              onSelect={(e) => e.preventDefault()}
            >{tt("Watch lost · prod-us-east-1")}</DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={scenarios.noMetrics}
              onCheckedChange={(on) => setScenario("noMetrics", on)}
              onSelect={(e) => e.preventDefault()}
            >{tt("No metrics · staging-eu-1")}</DropdownMenuCheckboxItem>
            <DropdownMenuItem className="pl-7" onSelect={simulateSlowList}>{tt("Slow initial list · prod-us-east-1")}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
