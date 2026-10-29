import { Box, Layers, Plus, Search, Settings, X } from "lucide-react";
import { useWorkspace, type WorkspaceTab } from "@/app/workspace";
import type { Density, Theme } from "@/app/preferences";
import { IconButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { cn } from "@/lib/cn";
import { isMac, modKey } from "@/lib/platform";
import { Logo } from "./Logo";

export function WindowToolbar() {
  return (
    <header
      className={cn(
        "drag-region flex h-10 shrink-0 items-center gap-3.5 border-b border-line bg-surface-side pr-2.5",
        isMac ? "pl-[78px]" : "pl-3.5",
      )}
    >
      <Logo />
      <WorkspaceTabs />
      <div className="flex-1" />
      <button
        type="button"
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

function WorkspaceTabs() {
  const { tabs, activeTabId, setActiveTabId, closeTab, selectedClusterIds } = useWorkspace();
  return (
    <nav aria-label="Workspace tabs" className="no-drag flex min-w-0 items-center gap-1">
      <div role="tablist" className="flex min-w-0 items-center gap-1">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className={cn(
                "flex h-7 min-w-0 items-center rounded-md text-fg-secondary",
                active && "bg-surface-hover text-fg shadow-[inset_0_0_0_1px_var(--line-strong)]",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTabId(tab.id)}
                className={cn(
                  "focus-ring flex h-7 min-w-0 items-center gap-[7px] rounded-md bg-transparent pl-2.5 text-cell font-medium leading-none text-inherit",
                  active && tabs.length > 1 ? "pr-1" : "pr-2.5",
                )}
              >
                <TabIcon tab={tab} />
                <span className="truncate">{tab.title}</span>
                {tab.kind === "pods" ? (
                  <span className="font-mono text-label text-fg-muted">
                    {selectedClusterIds.length} {selectedClusterIds.length === 1 ? "cluster" : "clusters"}
                  </span>
                ) : tab.subtitle ? (
                  <span className="text-label text-fg-muted">{tab.subtitle}</span>
                ) : null}
              </button>
              {active && tabs.length > 1 && (
                <IconButton aria-label={`Close ${tab.title}`} className="mr-1 size-[18px] [&_svg]:size-3" onClick={() => closeTab(tab.id)}>
                  <X />
                </IconButton>
              )}
            </div>
          );
        })}
      </div>
      <IconButton aria-label="New tab">
        <Plus className="!size-3.5" />
      </IconButton>
    </nav>
  );
}

function TabIcon({ tab }: { tab: WorkspaceTab }) {
  switch (tab.kind) {
    case "pods":
      return <Box className="size-3.5 shrink-0" aria-hidden />;
    case "resource":
      return <Layers className="size-3.5 shrink-0" aria-hidden />;
    case "investigation":
      return <StatusGlyph health="failed" />;
  }
}

function SettingsMenu() {
  const { theme, setTheme, density, setDensity } = useWorkspace();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton aria-label="Settings">
          <Settings />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
