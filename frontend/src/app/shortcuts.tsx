import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { IconButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { isMac, modKey } from "@/lib/platform";
import { useWorkspace } from "./workspace";

interface Overlays {
  openPalette: () => void;
  openHelp: () => void;
  /** ⌘⇧C: the active explorer's cluster picker. */
  clusterPickerOpen: boolean;
  setClusterPickerOpen: (open: boolean) => void;
}

const OverlayContext = createContext<Overlays | null>(null);

export function useOverlays() {
  const ctx = useContext(OverlayContext);
  if (!ctx) throw new Error("useOverlays must be used inside ShortcutsProvider");
  return ctx;
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && !!t.closest("input, textarea, select, [contenteditable], .xterm, .monaco-editor");

/** App-wide keyboard shortcuts plus the overlays they open (palette, help). */
export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const ws = useWorkspace();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [clusterPickerOpen, setClusterPickerOpen] = useState(false);
  const pendingG = useRef<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && !e.shiftKey && key === "k") {
        setPaletteOpen((o) => !o);
      } else if (mod && e.shiftKey && key === "t") {
        ws.reopenClosedTab();
      } else if (mod && e.shiftKey && key === "c") {
        setClusterPickerOpen((o) => !o);
      } else if (isTyping(e.target) || mod || e.altKey) {
        return;
      } else if (e.key === "?") {
        setHelpOpen(true);
      } else if (key === "g" && !e.shiftKey) {
        // "g" then a letter jumps to an explorer.
        pendingG.current = window.setTimeout(() => (pendingG.current = null), 1000);
        return;
      } else if (pendingG.current !== null) {
        clearTimeout(pendingG.current);
        pendingG.current = null;
        const target = { p: "pods", d: "deployments", n: "nodes", c: "clusters" }[key];
        if (!target) return;
        ws.openView({ kind: target as "pods", title: target[0]!.toUpperCase() + target.slice(1) });
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ws]);

  const value = useMemo(
    () => ({
      openPalette: () => setPaletteOpen(true),
      openHelp: () => setHelpOpen(true),
      clusterPickerOpen,
      setClusterPickerOpen,
    }),
    [clusterPickerOpen],
  );

  return (
    <OverlayContext.Provider value={value}>
      {children}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <KeyboardHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </OverlayContext.Provider>
  );
}

const KEYS: [string[], string][] = [
  [["J", "K"], "move row (also ↑ ↓)"],
  [["↵"], "inspect"],
  [["Space"], "select row"],
  [["⇧", "click"], "select range"],
  [[`${modKey}A`], "select all matching"],
  [["/"], "filter"],
  [["⇧F10"], "row actions"],
  [["Esc"], "close inspector"],
  [[`${modKey}\\`], "toggle inspector"],
  [["G", "P"], "go to Pods (D, N, C)"],
  [[`${modKey}K`], "command palette"],
  [[`${modKey}⇧C`], "pick clusters"],
  [[`${modKey}⇧T`], "reopen closed tab"],
  [["?"], "this help"],
];

function KeyboardHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[96px] z-50 w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-xl border border-line-strong bg-surface-elevated p-5 text-fg shadow-dialog"
        >
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="m-0 text-title font-semibold">Keyboard shortcuts</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton aria-label="Close">
                <X />
              </IconButton>
            </Dialog.Close>
          </div>
          <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 text-ui">
            {KEYS.map(([keys, label]) => (
              <div key={label} className="flex items-center gap-2">
                <dt className="flex min-w-[64px] gap-1">
                  {keys.map((k) => (
                    <Kbd key={k} className="min-w-[22px] text-center">
                      {k}
                    </Kbd>
                  ))}
                </dt>
                <dd className="m-0 text-fg-secondary">{label}</dd>
              </div>
            ))}
          </dl>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
