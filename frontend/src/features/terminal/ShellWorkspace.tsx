import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Columns2, Copy, Eraser, Pin, Plus, RefreshCw, Scaling, Search, X } from "lucide-react";
import { useWorkspace, type WorkspaceTab } from "@/app/workspace";
import { useOverlays } from "@/app/shortcuts";
import type { Environment } from "@/data/types";
import { Button, IconButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EnvironmentBadge, EnvMarker } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { cn } from "@/lib/cn";
import { isMac, modKey } from "@/lib/platform";
import { XtermPane, type XtermHandle } from "./XtermPane";

export interface ShellSession {
  id: string;
  cluster: string;
  env: Environment;
  namespace: string;
  pod: string;
  container: string;
  shell: string;
  state: "connected" | "reconnecting" | "ended";
  reconnect?: { attempt: number; inSec: number; reason: string };
  ended?: string;
  restore?: boolean;
  openedAt: string;
}

const PRESET: ShellSession[] = [
  {
    id: "s1",
    cluster: "prod-eu-west-1",
    env: "prod",
    namespace: "payments",
    pod: "checkout-api-7d9f8b6c4-9rkzd",
    container: "api",
    shell: "/bin/sh",
    state: "connected",
    restore: true,
    openedAt: "12:04",
  },
  {
    id: "s2",
    cluster: "staging-eu-1",
    env: "stg",
    namespace: "payments",
    pod: "ledger-sync-7f4c8b9d5-jx6nl",
    container: "sync",
    shell: "/bin/sh",
    state: "reconnecting",
    reconnect: { attempt: 2, inSec: 3, reason: "WebSocket closed (1006) after network change." },
    openedAt: "11:52",
  },
  {
    id: "s3",
    cluster: "prod-eu-west-1",
    env: "prod",
    namespace: "payments",
    pod: "checkout-api-7d9f8b6c4-9rkzd",
    container: "envoy",
    shell: "/bin/sh",
    state: "ended",
    ended: "exit 0 (you typed exit)",
    openedAt: "11:49",
  },
];

const short = (s: ShellSession) => `${s.container}@${s.pod.split("-").pop()}`;
const MAX_ATTEMPTS = 5;

/**
 * Container shells. Each session is an exec stream; the terminal is the
 * content. On production the context band cannot be hidden.
 */
export function ShellWorkspace({ active }: { tab: WorkspaceTab; active: boolean }) {
  const ws = useWorkspace();
  const { openPalette } = useOverlays();
  const [sessions, setSessions] = useState<ShellSession[]>(PRESET);
  const [activeId, setActiveId] = useState("s1");
  const [split, setSplit] = useState(true);
  const [size, setSize] = useState<Record<string, string>>({});
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const panes = useRef<Record<string, XtermHandle | null>>({});

  const current = sessions.find((s) => s.id === activeId) ?? sessions[0];
  const secondary = split ? sessions.find((s) => s.id !== current?.id && s.state !== "ended") : undefined;
  const update = (id: string, patch: Partial<ShellSession>) => setSessions((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  // Reconnect countdown; success on the next attempt in the mock.
  useEffect(() => {
    const t = setInterval(() => {
      setSessions((ss) =>
        ss.map((s) => {
          if (s.state !== "reconnecting" || !s.reconnect) return s;
          if (s.reconnect.inSec > 1) return { ...s, reconnect: { ...s.reconnect, inSec: s.reconnect.inSec - 1 } };
          return { ...s, state: "connected", reconnect: undefined };
        }),
      );
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Sessions requested from elsewhere (pod inspector, row menu) after confirmation.
  useEffect(() => {
    if (ws.reveal?.kind !== "session") return;
    const [cluster = "", namespace = "", pod = "", container = "app"] = ws.reveal.id.split("/");
    const id = `s${Date.now()}`;
    setSessions((ss) => [
      ...ss,
      {
        id,
        cluster,
        env: ws.clusterById(cluster)?.env ?? "dev",
        namespace,
        pod,
        container,
        shell: "/bin/sh",
        state: "connected",
        openedAt: new Date().toTimeString().slice(0, 5),
      },
    ]);
    setActiveId(id);
  }, [ws.reveal?.seq]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "d" && !e.shiftKey) setSplit((x) => !x);
      else if (k === "w" && !e.shiftKey && current) closeSession(current.id);
      else if (k === "r" && e.shiftKey && current) reconnect(current.id);
      else if (/^[1-9]$/.test(k) && sessions[Number(k) - 1]) setActiveId(sessions[Number(k) - 1]!.id);
      else if (k === "t" && !e.shiftKey) openPalette();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const closeSession = (id: string) => {
    const rest = sessions.filter((s) => s.id !== id);
    setSessions(rest);
    if (id === activeId && rest[0]) setActiveId(rest[0].id);
  };
  const reconnect = (id: string) => update(id, { state: "connected", reconnect: undefined, ended: undefined, restore: false });

  const prodSessions = sessions.filter((s) => s.env === "prod" && s.state !== "ended").length;
  const live = sessions.filter((s) => s.state !== "ended").length;

  if (!current) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-cell text-fg-secondary">
        No shell sessions. Open one from a pod’s inspector or row menu.
      </div>
    );
  }

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-app">
      {current.env === "prod" && (
        <div role="status" className="flex h-[34px] shrink-0 items-center gap-3 border-y border-env-prod bg-env-prod-soft pr-3 text-cell">
          <span className="hatch-prod w-7 self-stretch" aria-hidden />
          <EnvironmentBadge env="prod" label="PRODUCTION" className="bg-env-prod text-[#1A0E04] shadow-none" />
          <span className="font-mono font-semibold">{current.cluster}</span>
          <span className="min-w-0 flex-1 truncate text-fg-secondary">
            Live shell in a production container. Clustrail does not filter or undo commands; your RBAC (
            <span className="font-mono">pods/exec</span>) applies.
          </span>
          <span className="hidden whitespace-nowrap text-meta text-fg-muted min-[1360px]:inline">Opened after confirmation · {current.openedAt}</span>
        </div>
      )}

      <div className="flex h-[38px] shrink-0 items-end gap-0.5 border-b border-line-strong bg-surface-side px-2.5">
        <div role="tablist" aria-label="Shell sessions" className="flex min-w-0 items-end gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {sessions.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === current.id}
              title={`${s.cluster} › ${s.namespace} › ${s.pod} › ${s.container} (${modKey}${i + 1})`}
              onClick={() => setActiveId(s.id)}
              onAuxClick={(e) => e.button === 1 && closeSession(s.id)}
              className={cn(
                "focus-ring flex h-[30px] shrink-0 items-center gap-[7px] rounded-t-md border border-b-0 border-transparent px-2.5 text-ui font-medium text-fg-secondary",
                s.id === current.id && "border-line-strong bg-term-bg text-fg",
              )}
            >
              {s.env === "prod" ? <span className="hatch-prod h-3 w-2 rounded-[2px]" aria-label="production" /> : <EnvMarker env={s.env} />}
              <span className={cn("font-mono", s.state === "ended" && "text-fg-muted")}>{short(s)}</span>
              {s.state === "connected" && <span className="size-1.5 rounded-full bg-status-healthy" aria-label="connected" />}
              {s.state === "reconnecting" && <StatusGlyph health="progressing" />}
              {s.state === "ended" && <span className="text-meta text-fg-muted">ended</span>}
              {s.id === current.id && (
                <span
                  role="button"
                  aria-label={`Close ${short(s)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSession(s.id);
                  }}
                  className="inline-flex size-4 items-center justify-center rounded text-fg-muted hover:bg-surface-hover hover:text-fg"
                >
                  <X className="size-3" />
                </span>
              )}
            </button>
          ))}
        </div>
        <Tooltip content={`New session: pick a pod from the command palette (${modKey}T)`}>
          <IconButton aria-label="New session" className="mb-px" onClick={openPalette}>
            <Plus />
          </IconButton>
        </Tooltip>
        <div className="flex-1" />
        <div className="flex items-center gap-1 pb-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title="bash not found in image"
                className="focus-ring flex h-[26px] items-center gap-1.5 rounded-md border border-line-strong bg-transparent px-2 text-ui text-fg"
              >
                <span className="text-fg-muted">shell</span>
                <span className="font-mono">{current.shell}</span>
                <ChevronDown className="size-3.5 text-fg-muted" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Shell (tried in order)</DropdownMenuLabel>
              <DropdownMenuItem disabled>/bin/bash · not found in image</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => update(current.id, { shell: "/bin/sh" })}>/bin/sh</DropdownMenuItem>
              <DropdownMenuItem disabled>Custom command…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {size[current.id] && (
            <span className="hidden items-center gap-1 px-1.5 font-mono text-meta text-fg-muted min-[1360px]:flex">
              <Scaling className="size-3" aria-hidden />
              {size[current.id]}
            </span>
          )}
          <IconButton aria-label={split ? "Close split" : "Split pane"} aria-pressed={split} onClick={() => setSplit(!split)}>
            <Columns2 />
          </IconButton>
          <IconButton aria-label="Find in scrollback" aria-pressed={findOpen} onClick={() => setFindOpen(!findOpen)}>
            <Search />
          </IconButton>
          <IconButton aria-label="Copy selection" onClick={() => panes.current[current.id]?.copySelection()}>
            <Copy />
          </IconButton>
          <IconButton aria-label="Clear" onClick={() => panes.current[current.id]?.clear()}>
            <Eraser />
          </IconButton>
          <Button
            size="sm"
            onClick={() =>
              ws.pinToInvestigation({
                source: `Shell · ${short(current)}`,
                cluster: current.cluster,
                text: panes.current[current.id]?.visibleText().split("\n").slice(-12).join(" ⏎ ") ?? "",
              })
            }
          >
            <Pin aria-hidden />
            Pin output
          </Button>
        </div>
      </div>

      {findOpen && (
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line bg-surface-panel px-3">
          <Search className="size-3.5 text-fg-muted" aria-hidden />
          <input
            autoFocus
            aria-label="Find in scrollback"
            value={findText}
            onChange={(e) => {
              setFindText(e.target.value);
              panes.current[current.id]?.find(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") panes.current[current.id]?.find(findText, e.shiftKey);
              if (e.key === "Escape") {
                setFindOpen(false);
                panes.current[current.id]?.focus();
              }
            }}
            placeholder="Find in scrollback (Enter next, ⇧Enter previous)"
            className="min-w-0 flex-1 border-0 bg-transparent font-mono text-cell text-fg outline-none placeholder:font-sans placeholder:text-fg-muted"
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {[current, secondary].filter((s): s is ShellSession => !!s).map((s, i) => (
          <div key={s.id} className="contents">
            {i === 1 && <div className="w-1.5 shrink-0 cursor-col-resize border-x border-line bg-surface-side" aria-hidden />}
            <section
              aria-label={`Session ${short(s)}`}
              className={cn("relative flex min-w-0 flex-col", i === 0 ? "flex-1" : "basis-[440px] shrink-0", i === 0 && "shadow-[inset_0_0_0_1px_var(--line-selected)]")}
            >
              <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-surface-panel px-2.5 text-meta text-fg-secondary">
                <EnvironmentBadge env={s.env} size="sm" />
                <span className="truncate font-mono">
                  {s.cluster} <span className="text-fg-muted">›</span> {s.namespace} <span className="text-fg-muted">›</span> {s.pod}{" "}
                  <span className="text-fg-muted">›</span> <b className="font-semibold text-fg">{s.container}</b>
                </span>
                <div className="flex-1" />
                <span className="font-mono text-fg-muted">uid 1000</span>
              </div>
              <div
                className={cn("min-h-0 flex-1 bg-term-bg px-3.5 py-2.5", s.state !== "connected" && "opacity-45")}
                onClick={() => setActiveId(s.id)}
              >
                <XtermPane
                  ref={(h) => {
                    panes.current[s.id] = h;
                  }}
                  sessionId={s.id}
                  restore={!!s.restore}
                  cwd={s.restore ? "/app" : "/"}
                  themeKey={ws.theme}
                  interactive={s.state === "connected"}
                  onResize={(c, r) => setSize((m) => (m[s.id] === `${c}×${r}` ? m : { ...m, [s.id]: `${c}×${r}` }))}
                  onExit={(code) => update(s.id, { state: "ended", ended: `exit ${code} (you typed exit)` })}
                  onLeave={() => (document.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement | null)?.focus()}
                />
              </div>
              {s.state === "reconnecting" && s.reconnect && (
                <Overlay>
                  <div className="flex items-center gap-2">
                    <StatusGlyph health="progressing" />
                    <b className="font-semibold">Connection lost — reconnecting in {s.reconnect.inSec}s</b>
                  </div>
                  <span className="text-fg-secondary">
                    {s.reconnect.reason} Attempt {s.reconnect.attempt} of {MAX_ATTEMPTS}. The container is still Running; scrollback is kept.
                  </span>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="primary" onClick={() => reconnect(s.id)}>
                      <RefreshCw aria-hidden />
                      Reconnect now
                    </Button>
                    <Button size="sm" onClick={() => closeSession(s.id)}>
                      Close session
                    </Button>
                  </div>
                </Overlay>
              )}
              {s.state === "ended" && (
                <Overlay>
                  <b className="font-semibold">Session ended · {s.ended}</b>
                  <span className="text-fg-secondary">The container keeps running. A new session starts a new shell process.</span>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="primary" onClick={() => reconnect(s.id)}>
                      <RefreshCw aria-hidden />
                      Reconnect
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        ws.openView({
                          kind: "logs",
                          title: `Logs · ${s.pod.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, "")}`,
                          cluster: s.cluster,
                          params: { namespace: s.namespace, workload: s.pod.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, "") },
                        })
                      }
                    >
                      Open logs
                    </Button>
                  </div>
                </Overlay>
              )}
            </section>
          </div>
        ))}
      </div>

      <div className="flex h-7 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-t border-line bg-surface-panel px-3.5 text-meta text-fg-muted dark:bg-transparent">
        {[`${modKey}T new`, `${modKey}D split`, `${modKey}W close`, `${modKey}1–9 switch`, `${modKey}⇧R reconnect`].map((k) => {
          const [key, label] = k.split(" ") as [string, string];
          return (
            <span key={k} className="flex items-center gap-1.5">
              <Kbd>{key}</Kbd>
              {label}
            </span>
          );
        })}
        <span className="flex items-center gap-1.5">
          <Kbd>Esc Esc</Kbd>leave terminal
        </span>
        <div className="flex-1" />
        <span className="hidden min-[1360px]:inline">
          Scrollback 10,000 lines · {live} live · {prodSessions} production
        </span>
      </div>
    </main>
  );
}

function Overlay({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-x-6 top-[110px] flex flex-col gap-2 rounded-[10px] border border-line-strong bg-surface-elevated p-3.5 text-cell shadow-menu">
      {children}
    </div>
  );
}
