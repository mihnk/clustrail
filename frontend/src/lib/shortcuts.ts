import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { isMac } from "./platform";

// Shortcuts are written with macOS glyphs ("⇧R", "⌘⌫", "L") and mean the
// Ctrl equivalent on Windows and Linux.

const KEY_NAMES: Record<string, string> = { "⌫": "Backspace", "↵": "Enter" };

export function matchesShortcut(e: KeyboardEvent | ReactKeyboardEvent, shortcut: string): boolean {
  const mod = shortcut.includes("⌘");
  const shift = shortcut.includes("⇧");
  const key = shortcut.replace(/[⌘⇧]/g, "");
  const want = KEY_NAMES[key] ?? key;
  const modPressed = isMac ? e.metaKey : e.ctrlKey;
  return (
    e.key.toLowerCase() === want.toLowerCase() &&
    modPressed === mod &&
    e.shiftKey === shift &&
    !e.altKey &&
    (isMac ? !e.ctrlKey : !e.metaKey)
  );
}

export function formatShortcut(shortcut: string): string {
  return isMac ? shortcut : shortcut.replace("⌘", "Ctrl+").replace("⇧", "Shift+");
}
