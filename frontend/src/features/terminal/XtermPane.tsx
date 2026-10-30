import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { MockShell, SCROLLBACK } from "./mockShell";

export interface XtermHandle {
  copySelection: () => void;
  clear: () => void;
  find: (text: string, backwards?: boolean) => boolean;
  focus: () => void;
  /** Visible output as text, for pinning to an investigation. */
  visibleText: () => string;
}

const SCROLLBACK_LINES = 10_000;

/** xterm.js theme from the app's CSS tokens, so dark and light both apply. */
function themeFromTokens(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return {
    background: v("--term-bg"),
    foreground: v("--term-fg"),
    cursor: v("--term-fg"),
    cursorAccent: v("--term-bg"),
    selectionBackground: v("--accent-soft"),
    black: v("--surface-elevated"),
    red: v("--status-critical"),
    green: v("--status-healthy"),
    yellow: v("--status-warning"),
    blue: v("--status-progressing"),
    magenta: v("--env-stg"),
    cyan: v("--accent"),
    white: v("--term-fg"),
    brightBlack: v("--fg-muted"),
  };
}

export const XtermPane = forwardRef<
  XtermHandle,
  {
    sessionId: string;
    /** Show the earlier scrollback of a session that was already open. */
    restore: boolean;
    cwd: string;
    themeKey: string;
    /** Live sessions accept input; others are read-only. */
    interactive: boolean;
    onResize: (cols: number, rows: number) => void;
    onExit: (code: number) => void;
    /** Esc Esc moves focus back to the app. */
    onLeave: () => void;
  }
>(function XtermPane({ sessionId, restore, cwd, themeKey, interactive, onResize, onExit, onLeave }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const cb = useRef({ onResize, onExit, onLeave });
  cb.current = { onResize, onExit, onLeave };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono") || "monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: SCROLLBACK_LINES,
      theme: themeFromTokens(),
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(host);
    termRef.current = term;
    searchRef.current = search;

    // App shortcuts (⌘/Ctrl combos) go to the app, not the shell.
    let lastEsc = 0;
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.key === "Escape") {
        const now = Date.now();
        if (now - lastEsc < 400) {
          cb.current.onLeave();
          return false;
        }
        lastEsc = now;
      }
      if ((e.metaKey || (e.ctrlKey && e.shiftKey)) && e.key.length === 1) return false;
      return true;
    });

    const shell = new MockShell((d) => term.write(d), cwd, (code) => cb.current.onExit(code));
    if (restore) term.write(SCROLLBACK);
    shell.prompt();
    const sub = term.onData((d) => interactiveRef.current && shell.input(d));

    const doFit = () => {
      if (!host.offsetWidth || !host.offsetHeight) return;
      fit.fit();
      cb.current.onResize(term.cols, term.rows);
    };
    const ro = new ResizeObserver(doFit);
    ro.observe(host);
    requestAnimationFrame(doFit);

    return () => {
      ro.disconnect();
      sub.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = themeFromTokens();
  }, [themeKey]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.cursorBlink = interactive;
  }, [interactive]);

  useImperativeHandle(ref, () => ({
    copySelection: () => {
      const sel = termRef.current?.getSelection();
      if (sel) void navigator.clipboard?.writeText(sel);
    },
    clear: () => termRef.current?.clear(),
    find: (text, backwards) => (backwards ? searchRef.current?.findPrevious(text) : searchRef.current?.findNext(text)) ?? false,
    focus: () => termRef.current?.focus(),
    visibleText: () => {
      const t = termRef.current;
      if (!t) return "";
      const buf = t.buffer.active;
      const lines: string[] = [];
      for (let i = buf.viewportY; i < buf.viewportY + t.rows; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
      return lines.join("\n").trimEnd();
    },
  }));

  return <div ref={hostRef} className="h-full w-full" role="application" aria-label="Terminal" />;
});
