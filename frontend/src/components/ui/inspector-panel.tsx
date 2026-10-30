import { useEffect, type ReactNode } from "react";
import { PanelRightOpen } from "lucide-react";
import { usePersistentState } from "@/app/preferences";
import { isMac } from "@/lib/platform";
import { ResizeHandle } from "./resize-handle";
import { Tooltip } from "./tooltip";

const MIN = 320;
const MAX = 640;
const COLLAPSE_BELOW = 300;

/**
 * Right-docked inspector: resizable 320–640px (double-click the grip to reset),
 * dragging below 320 collapses it to a 28px strip, ⌘\ toggles it. The width is
 * remembered per view.
 */
export function InspectorPanel({
  label,
  storageKey,
  defaultWidth = 380,
  active,
  children,
}: {
  label: string;
  /** Preference key, e.g. "pods" — widths are remembered per view. */
  storageKey: string;
  defaultWidth?: number;
  /** Only the active tab listens for ⌘\. */
  active: boolean;
  children: ReactNode;
}) {
  const [width, setWidth] = usePersistentState(`inspector.${storageKey}.width`, defaultWidth);
  const [collapsed, setCollapsed] = usePersistentState(`inspector.${storageKey}.collapsed`, false);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key === "\\") {
        setCollapsed(!collapsed);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, collapsed, setCollapsed]);

  if (collapsed) {
    return (
      <aside aria-label={`${label} (collapsed)`} className="flex w-7 shrink-0 flex-col items-center border-l border-line bg-surface-panel pt-2">
        <Tooltip content={`Show ${label.toLowerCase()} (${isMac ? "⌘" : "Ctrl+"}\\)`} side="left">
          <button
            type="button"
            aria-label={`Show ${label.toLowerCase()}`}
            onClick={() => setCollapsed(false)}
            className="focus-ring flex size-6 items-center justify-center rounded-md border-0 bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg"
          >
            <PanelRightOpen className="size-4" />
          </button>
        </Tooltip>
      </aside>
    );
  }

  return (
    <aside
      aria-label={label}
      style={{ width }}
      className="relative flex shrink-0 flex-col overflow-hidden border-l border-line bg-surface-panel"
    >
      <ResizeHandle
        label={`Resize ${label.toLowerCase()}`}
        value={width}
        min={COLLAPSE_BELOW - 40}
        max={MAX}
        onChange={(w) => {
          if (w < COLLAPSE_BELOW) {
            setCollapsed(true);
            setWidth(MIN);
          } else setWidth(Math.max(MIN, w));
        }}
        onReset={() => setWidth(defaultWidth)}
      />
      {children}
    </aside>
  );
}
