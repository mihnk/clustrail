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
        className="focus-ring no-drag flex h-7 w-[300px] items-center gap-1.5 rounded-md border border-line-strong bg-surface-panel pl-2 pr-1.5 text-cell text-fg-muted"
      >
        <Search className="size-3.5" aria-hidden />
        <span className="flex-1 text-left">Go to resource or run command…</span>
        <Kbd>{modKey}K</Kbd>
      </button>
      <SettingsMenu />
    </header>
  );
}

/** Rough width of a compact tab, for deciding what overflows. */
function tabWidth(tab: WorkspaceTab, active: boolean) {
  return 40 + tab.title.length * 7 + (tab.cluster ? 44 : 0) + (active ? 60 : 0);
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
  const budget = width - 70;
  const visible: WorkspaceTab[] = [];
  let used = 0;
  for (const t of tabs) {
    const w = tabWidth(t, t.id === activeTabId);
    if (used + w <= budget || width === 0) {
      visible.push(t);
      used += w;
    }
  }
  const active = tabs.find((t) => t.id === activeTabId);
  if (active && !visible.includes(active)) {
    visible.pop();
    visible.push(active);
  }
  const overflow = tabs.filter((t) => !visible.includes(t));

  return (
    <nav ref={navRef} aria-label="Workspace tabs" className="no-drag flex min-w-0 flex-1 items-center gap-1">
      <div role="tablist" className="flex min-w-0 items-center gap-1">
        {visible.map((tab) => {
          const isActive = tab.id === activeTabId;
          const secondary = tab.cluster ? (
            <span className="font-mono text-label text-fg-muted">{tab.cluster}</span>
          ) : tab.kind === "pods" ? (
            <span className="font-mono text-label text-fg-muted">
              {selectedClusterIds.length} {selectedClusterIds.length === 1 ? "cluster" : "clusters"}
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
                "flex h-7 min-w-0 shrink-0 items-center rounded-md text-fg-secondary",
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
                <IconButton aria-label={`Close ${tab.title}`} className="mr-1 size-[18px] [&_svg]:size-3" onClick={() => closeTab(tab.id)}>
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
            <Button size="sm" variant="ghost" aria-label={`${overflow.length} more tabs`}>
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
        <IconButton aria-label="New tab" onClick={openPalette}>
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
        <IconButton aria-label="Settings">
          <Settings />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={themePreference} onValueChange={(v) => setTheme(v as ThemePreference)}>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Table density</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={density} onValueChange={(v) => setDensity(v as Density)}>
          <DropdownMenuRadioItem value="compact">Compact · 24px</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="default">Default · 28px</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="comfortable">Comfortable · 34px</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openView({ kind: "settings", title: "Settings" })}>
          <Settings aria-hidden />
          All settings…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={openHelp}>
          Keyboard shortcuts
          <span className="ml-auto font-mono text-label text-fg-muted">?</span>
        </DropdownMenuItem>
        {IS_MOCK && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Mock scenarios</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={scenarios.watchLost}
              onCheckedChange={(on) => setScenario("watchLost", on)}
              onSelect={(e) => e.preventDefault()}
            >
              Watch lost · prod-us-east-1
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={scenarios.noMetrics}
              onCheckedChange={(on) => setScenario("noMetrics", on)}
              onSelect={(e) => e.preventDefault()}
            >
              No metrics · staging-eu-1
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem className="pl-7" onSelect={simulateSlowList}>
              Slow initial list · prod-us-east-1
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
