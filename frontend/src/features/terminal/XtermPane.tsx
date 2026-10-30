import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { usePersistentState } from "@/app/preferences";
import { backend, errorText, EVENTS, onEvent, type ExecOutput } from "@/backend/client";
import { MockShell, SCROLLBACK } from "./mockShell";

/** The container a desktop session executes in. */
export interface ExecTarget {
  cluster: string;
  namespace: string;
  pod: string;
  /** Empty: the pod's default container. */
  container: string;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const NO_REMOTE = { resize: () => {} };

export interface XtermHandle {
  copySelection: () => void;
  clear: () => void;
  find: (text: string, backwards?: boolean) => boolean;
  focus: () => void;
  /** Visible output as text, for pinning to an investigation. */
  visibleText: () => string;
}

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
    onExit: (code: number, error?: string) => void;
    /** Desktop: run a real exec session in this container instead of the mock shell. */
    target?: ExecTarget;
    /** Esc Esc moves focus back to the app. */
    onLeave: () => void;
    /** Desktop: bump to start a new exec in the same terminal (reconnect). */
    connection?: number;
  }
>(function XtermPane({ sessionId, restore, cwd, themeKey, interactive, onResize, onExit, onLeave, target, connection = 0 }, ref) {
  const [scrollback] = usePersistentState("terminal.scrollback", 10_000);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const cb = useRef({ onResize, onExit, onLeave });
  const remote = useRef<{ resize: (cols: number, rows: number) => void }>(NO_REMOTE);
  cb.current = { onResize, onExit, onLeave };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono") || "monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback,
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

    let sub: { dispose: () => void } | null = null;
    if (!(target && backend)) {
      const shell = new MockShell((d) => term.write(d), cwd, (code) => cb.current.onExit(code));
      if (restore) term.write(SCROLLBACK);
      shell.prompt();
      sub = term.onData((d) => interactiveRef.current && shell.input(d));
    }

    const doFit = () => {
      if (!host.offsetWidth || !host.offsetHeight) return;
      fit.fit();
      cb.current.onResize(term.cols, term.rows);
      remote.current.resize(term.cols, term.rows);
    };
    const ro = new ResizeObserver(doFit);
    ro.observe(host);
    requestAnimationFrame(doFit);

    return () => {
      ro.disconnect();
      sub?.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId]);

  // Desktop: the exec stream, separate from the terminal so a reconnect keeps the scrollback.
  // A new connection value starts a new exec (a new shell process in the container).
  useEffect(() => {
    const term = termRef.current;
    if (!term || !target || !backend) return;
    const api = backend;
    let execId: string | null = null;
    let ended = false;
    const early: ExecOutput[] = [];
    if (connection > 0) term.write(`\r\n\x1b[2m— reconnected · new shell process —\x1b[0m\r\n`);
    const handle = (o: ExecOutput) => {
      if (o.data) term.write(base64ToBytes(o.data));
      if (o.exit !== undefined) {
        ended = true;
        if (o.error) term.write(`\r\n\x1b[31m${o.error}\x1b[0m\r\n`);
        cb.current.onExit(o.exit, o.error);
      }
    };
    const off = onEvent<ExecOutput>(EVENTS.exec, (o) => {
      if (execId === null) early.push(o);
      else if (o.id === execId) handle(o);
    });
    let disposed = false;
    api
      .startExec({ ...target, command: [], cols: term.cols, rows: term.rows })
      .then((id) => {
        if (disposed) return void api.closeExec(id);
        execId = id;
        void api.execResize(id, term.cols, term.rows);
        early.filter((o) => o.id === id).forEach(handle);
      })
      .catch((e) => {
        const msg = errorText(e);
        term.write(`\x1b[31m${msg}\x1b[0m\r\n`);
        cb.current.onExit(-1, msg);
      });
    const sub = term.onData((d) => {
      if (interactiveRef.current && execId) void api.execInput(execId, d);
    });
    remote.current = { resize: (c, r) => execId && void api.execResize(execId, c, r) };
    return () => {
      disposed = true;
      off();
      sub.dispose();
      remote.current = NO_REMOTE;
      if (execId && !ended) void api.closeExec(execId);
    };
  }, [sessionId, connection]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = themeFromTokens();
  }, [themeKey]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.cursorBlink = interactive;
  }, [interactive]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.scrollback = scrollback;
  }, [scrollback]);

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
