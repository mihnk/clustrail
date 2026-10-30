import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ChevronDown,
  ChevronUp,
  Clock,
  Columns2,
  Copy,
  Download,
  Filter,
  History,
  Layers,
  Pause,
  Pin,
  Play,
  Plus,
  Search,
  WrapText,
} from "lucide-react";
import { useWorkspace, type WorkspaceTab } from "@/app/workspace";
import { usePersistentState } from "@/app/preferences";
import {
  checkoutSources,
  initialBuffer,
  nextLines,
  previousInstance,
  type LogLine,
  type LogSource,
  type SourceTag,
} from "@/data/logs";
import { Button, IconButton } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Kbd } from "@/components/ui/kbd";
import { Meter } from "@/components/ui/meter";
import { Segmented } from "@/components/ui/segmented";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { cn } from "@/lib/cn";
import { LogView, TagChip } from "./LogView";

const RANGES = ["5m", "15m", "1h", "6h", "all"] as const;

/**
 * Logs of a workload's pods: merged by timestamp or split per pod, follow
 * mode, search, bounded buffer. Pausing stops the display, not ingestion.
 */
export function LogsWorkspace({ tab, active }: { tab: WorkspaceTab; active: boolean }) {
  const ws = useWorkspace();
  const cluster = tab.cluster ? ws.clusterById(tab.cluster) : undefined;
  const workload = tab.params?.workload ?? "checkout-api";
  const namespace = tab.params?.namespace ?? "payments";
  const [bufferLimit] = usePersistentState("logs.bufferLines", 100_000);

  const [sources, setSources] = useState<LogSource[]>(checkoutSources);
  const [enabled, setEnabled] = useState<Set<SourceTag>>(new Set(["A", "B", "C"]));
  const [containers, setContainers] = useState<Record<string, Set<string>>>({ A: new Set(["api"]), B: new Set(["api"]), C: new Set(["api"]), D: new Set(["api"]) });
  const [instance, setInstance] = useState<"current" | "previous">(tab.params?.previous ? "previous" : "current");
  const [range, setRange] = useState<(typeof RANGES)[number]>("15m");
  const [layout, setLayout] = useState<"merged" | "split">("merged");
  // New log views start from the defaults in Settings › Logs & terminal.
  const [defaultTs] = usePersistentState("logs.timestamps", true);
  const [defaultWrap] = usePersistentState("logs.wrap", false);
  const [showTs, setShowTs] = useState(defaultTs);
  const [wrap, setWrap] = useState(defaultWrap);
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [onlyMatching, setOnlyMatching] = useState(false);
  const [matchPos, setMatchPos] = useState(0);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);

  // Buffer: ingestion never stops; "paused" freezes what is displayed.
  const buffer = useRef<LogLine[]>(initialBuffer());
  const [version, setVersion] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [paused, setPaused] = useState(true);
  const [pausedAt, setPausedAt] = useState<{ count: number; time: string } | null>({ count: buffer.current.length, time: "12:01:17" });
  const nextId = useRef(buffer.current.length);

  useEffect(() => {
    // Source x2kqp comes back as a new instance after a few seconds.
    const reconnect = setTimeout(
      () => setSources((ss) => ss.map((s) => (s.tag === "A" ? { ...s, state: "live", note: undefined } : s))),
      6000,
    );
    return () => clearTimeout(reconnect);
  }, []);

  useEffect(() => {
    const live = sources.filter((s) => s.state === "live").map((s) => s.tag);
    if (!live.length) return;
    const t = setInterval(() => {
      const batch = nextLines(nextId.current, 3 + Math.floor(Math.random() * 6), live, new Date());
      nextId.current += batch.length;
      const b = buffer.current;
      b.push(...batch);
      if (b.length > bufferLimit) {
        const over = b.length - bufferLimit;
        b.splice(0, over);
        setDropped((d) => d + over);
      }
      setVersion((v) => v + 1);
    }, 700);
    return () => clearInterval(t);
  }, [sources, bufferLimit]);

  const matcher = useMemo(() => {
    if (!query) return null;
    try {
      return new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    } catch {
      return null;
    }
  }, [query, regex]);
  const regexError = regex && query && !matcher;

  const visibleCount = paused && pausedAt ? Math.min(pausedAt.count, buffer.current.length) : buffer.current.length;
  const lines = useMemo(() => {
    const src =
      instance === "previous" ? [...enabled].flatMap((t) => previousInstance(t)) : buffer.current.slice(0, visibleCount);
    return src.filter(
      (l) =>
        enabled.has(l.tag) &&
        (l.event || containers[l.tag]?.has(l.container)) &&
        (!onlyMatching || !matcher || l.event || (matcher.lastIndex = 0, matcher.test(l.msg))),
    );
  }, [version, visibleCount, enabled, containers, instance, onlyMatching, matcher]);

  const matches = useMemo(() => {
    if (!matcher) return [];
    return lines.filter((l) => !l.event && ((matcher.lastIndex = 0), matcher.test(l.msg))).map((l) => l.id);
  }, [lines, matcher]);
  const currentMatch = matches.length ? matches[Math.min(matchPos, matches.length - 1)]! : null;
  const newSincePause = paused && pausedAt ? buffer.current.length - pausedAt.count : 0;

  const pause = () => {
    setPaused(true);
    setPausedAt({ count: buffer.current.length, time: new Date().toTimeString().slice(0, 8) });
  };
  const resume = () => {
    setPaused(false);
    setPausedAt(null);
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("input, textarea")) return;
      if (e.key === "End") {
        resume();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const exportBuffer = () => {
    const text = buffer.current.map((l) => `${l.ts} ${l.tag} ${l.level} ${l.msg}`).join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${workload}-${tab.cluster}-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const live = sources.filter((s) => enabled.has(s.tag) && s.state === "live").length;
  const reconnecting = sources.filter((s) => enabled.has(s.tag) && s.state === "reconnecting");
  const ended = sources.filter((s) => enabled.has(s.tag) && s.state === "ended");
  // ~260 bytes per buffered line.
  const bytes = ((buffer.current.length * 260) / 1e6).toFixed(1);
  const sourceOf = (tag: SourceTag) => sources.find((s) => s.tag === tag);

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-label="Log sources" className="flex w-[264px] shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-line bg-surface-panel px-2.5 py-3">
        <div className="flex items-center px-1">
          <span className="section-label flex-1">Sources</span>
          <Button size="sm" variant="ghost" disabled title="Adding other workloads is not implemented in this build.">
            <Plus aria-hidden />
            Add
          </Button>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg border border-line p-2">
          <div className="flex items-center gap-1.5 text-ui">
            <Layers className="size-3.5 text-fg-muted" aria-hidden />
            <span className="truncate font-mono font-semibold">{workload}</span>
            {cluster && <EnvironmentBadge env={cluster.env} className="ml-auto" />}
          </div>
          <span className="pb-1.5 pl-5 text-meta text-fg-muted">
            {namespace} · {tab.cluster} · {sources.length} pods
          </span>
          {sources.map((s) => (
            <div key={s.tag}>
              <label className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-1.5 text-ui">
                <Checkbox
                  checked={enabled.has(s.tag)}
                  aria-label={`Include ${s.pod}`}
                  onCheckedChange={(on) => {
                    const next = new Set(enabled);
                    if (on) next.add(s.tag);
                    else next.delete(s.tag);
                    setEnabled(next);
                  }}
                />
                <TagChip tag={s.tag} />
                <span className={cn("min-w-0 flex-1 truncate font-mono", !enabled.has(s.tag) && "text-fg-secondary")}>…{s.pod.split("-").pop()}</span>
                <StreamState source={s} enabled={enabled.has(s.tag)} />
              </label>
              {enabled.has(s.tag) && (
                <div className="flex gap-1 pb-1.5 pl-[50px]">
                  {s.containers.map((c) => {
                    const on = containers[s.tag]?.has(c);
                    return (
                      <button
                        key={c}
                        type="button"
                        aria-pressed={on}
                        onClick={() => {
                          const set = new Set(containers[s.tag]);
                          if (on) set.delete(c);
                          else set.add(c);
                          setContainers({ ...containers, [s.tag]: set });
                        }}
                        className={cn(
                          "focus-ring inline-flex h-5 items-center rounded px-1.5 font-mono text-label",
                          on ? "border border-line-selected bg-accent-soft text-fg" : "border border-line-strong bg-transparent text-fg-muted",
                        )}
                      >
                        {c}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-1.5 px-1">
          <span className="section-label">Container instance</span>
          <Segmented
            aria-label="Instance"
            value={instance}
            onValueChange={setInstance}
            options={[
              { value: "current", label: "Current" },
              { value: "previous", label: <><History className="size-3.5" aria-hidden />Previous</> },
            ]}
          />
          <span className="text-meta leading-[1.4] text-fg-muted">Previous shows the last terminated instance only — Kubernetes keeps one.</span>
        </div>
        <div className="flex flex-col gap-1.5 px-1">
          <span className="section-label">Range</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="focus-ring flex h-[26px] items-center justify-between rounded-md border border-line-strong bg-transparent px-2 text-ui text-fg">
                <span>
                  <span className="text-fg-muted">since</span> {range}
                </span>
                <ChevronDown className="size-3.5 text-fg-muted" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Since</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={range} onValueChange={(v) => setRange(v as typeof range)}>
                {RANGES.map((r) => (
                  <DropdownMenuRadioItem key={r} value={r}>
                    {r === "all" ? "everything the API keeps" : r}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex-1" />
        <div className="flex flex-col gap-1 rounded-lg bg-surface-app p-2 text-meta">
          <div className="flex">
            <span className="flex-1 text-fg-secondary">Buffer</span>
            <span className="font-mono">
              {buffer.current.length.toLocaleString()} / {bufferLimit.toLocaleString()} lines
            </span>
          </div>
          <Meter value={buffer.current.length / bufferLimit} label="Buffer used" className="flex-none" />
          <div className="flex text-fg-muted">
            <span className="flex-1">
              {bytes} MB · oldest {buffer.current[0]?.ts.slice(0, 8)}
            </span>
            <span>{dropped.toLocaleString()} dropped</span>
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-surface-app">
        <div className="flex h-[46px] shrink-0 items-center gap-1.5 border-b border-line bg-surface-panel pl-3.5 pr-3 dark:bg-transparent">
          {paused ? (
            <Button variant="primary" onClick={resume}>
              <Play aria-hidden />
              Resume
            </Button>
          ) : (
            <Button onClick={pause}>
              <Pause aria-hidden />
              Pause
            </Button>
          )}
          <Segmented
            aria-label="Layout"
            value={layout}
            onValueChange={setLayout}
            options={[
              { value: "merged", label: "Merged" },
              { value: "split", label: <><Columns2 className="size-3.5" aria-hidden />Split</> },
            ]}
          />
          <ToggleIcon label="Timestamps" pressed={showTs} onClick={() => setShowTs(!showTs)}>
            <Clock />
          </ToggleIcon>
          <ToggleIcon label="Wrap lines" pressed={wrap} onClick={() => setWrap(!wrap)}>
            <WrapText />
          </ToggleIcon>
          <span className="mx-0.5 h-7 w-px bg-line" aria-hidden />
          <label
            className={cn(
              "flex h-7 w-[260px] shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-surface-panel pl-2 pr-1 text-fg-muted focus-within:border-accent",
              regexError && "border-status-critical focus-within:border-status-critical",
            )}
          >
            <Search className="size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">Search logs</span>
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setMatchPos(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") setMatchPos((p) => (matches.length ? (p + (e.shiftKey ? matches.length - 1 : 1)) % matches.length : 0));
                if (e.key === "Escape") setQuery("");
              }}
              placeholder="Search buffered lines"
              spellCheck={false}
              className="min-w-0 flex-1 border-0 bg-transparent font-mono text-cell text-fg outline-none placeholder:font-sans placeholder:text-fg-muted"
            />
            {query && (
              <span className="whitespace-nowrap font-mono text-label text-fg-secondary">
                {regexError ? "invalid" : matches.length ? `${Math.min(matchPos, matches.length - 1) + 1} / ${matches.length}` : "0"}
              </span>
            )}
            <IconButton aria-label="Previous match" className="size-5 [&_svg]:size-3.5" onClick={() => setMatchPos((p) => (matches.length ? (p - 1 + matches.length) % matches.length : 0))}>
              <ChevronUp />
            </IconButton>
            <IconButton aria-label="Next match" className="size-5 [&_svg]:size-3.5" onClick={() => setMatchPos((p) => (matches.length ? (p + 1) % matches.length : 0))}>
              <ChevronDown />
            </IconButton>
          </label>
          <button
            type="button"
            aria-pressed={regex}
            onClick={() => setRegex(!regex)}
            title="Regular expression"
            className={cn("focus-ring h-[26px] rounded-md border px-2 font-mono text-ui", regex ? "border-line-selected bg-accent-soft text-fg" : "border-line-strong bg-transparent text-fg")}
          >
            .*
          </button>
          <button
            type="button"
            aria-pressed={onlyMatching}
            onClick={() => setOnlyMatching(!onlyMatching)}
            className={cn(
              "focus-ring flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-ui",
              onlyMatching ? "border-line-selected bg-accent-soft text-fg" : "border-line-strong bg-transparent text-fg",
            )}
          >
            <Filter className="size-3.5" aria-hidden />
            Only matching
          </button>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            disabled={selectedLine === null}
            title={selectedLine === null ? "Click a line to select it" : undefined}
            onClick={() => {
              const l = buffer.current.find((x) => x.id === selectedLine);
              if (!l) return;
              ws.pinToInvestigation({
                source: `Logs · ${workload} · ${l.tag} ${sourceOf(l.tag)?.pod.split("-").pop() ?? ""}`,
                cluster: tab.cluster ?? "",
                text: `${l.ts} ${l.level} ${l.msg}`,
              });
            }}
          >
            <Pin aria-hidden />
            Pin selection
          </Button>
          <IconButton
            aria-label="Copy visible lines"
            onClick={() => void navigator.clipboard?.writeText(lines.slice(-200).map((l) => `${l.ts} ${l.tag} ${l.level} ${l.msg}`).join("\n"))}
          >
            <Copy />
          </IconButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <Download aria-hidden />
                Export
                <ChevronDown aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={exportBuffer}>Save buffer as .log…</DropdownMenuItem>
              <DropdownMenuItem disabled>Fetch full log from the API</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="relative flex min-h-0 flex-1">
          {layout === "merged" ? (
            <LogView
              label="Merged log stream"
              lines={lines}
              showTimestamps={showTs}
              wrap={wrap}
              matcher={matcher}
              currentMatchId={currentMatch}
              selectedId={selectedLine}
              onSelect={setSelectedLine}
              follow={!paused && instance === "current"}
              onScrollAway={pause}
              scrollToId={currentMatch}
            />
          ) : (
            <div className="grid min-h-0 flex-1 gap-px bg-line" style={{ gridTemplateColumns: `repeat(${Math.max(1, enabled.size)}, minmax(0, 1fr))` }}>
              {[...enabled].sort().map((tag) => (
                <div key={tag} className="flex min-h-0 flex-col bg-term-bg">
                  <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line px-3 font-mono text-ui text-fg-secondary">
                    <TagChip tag={tag} />
                    …{sourceOf(tag)?.pod.split("-").pop()}
                  </div>
                  <LogView
                    label={`Logs of ${sourceOf(tag)?.pod}`}
                    lines={lines.filter((l) => l.tag === tag)}
                    showTimestamps={showTs}
                    wrap={wrap}
                    matcher={matcher}
                    currentMatchId={currentMatch}
                    selectedId={selectedLine}
                    onSelect={setSelectedLine}
                    follow={!paused && instance === "current"}
                    onScrollAway={pause}
                    scrollToId={currentMatch}
                  />
                </div>
              ))}
            </div>
          )}

          {paused && instance === "current" && (
            <div className="absolute bottom-3.5 left-1/2 flex -translate-x-1/2 items-center gap-2.5 rounded-lg border border-line-strong bg-surface-elevated py-1.5 pl-3 pr-1.5 text-cell shadow-menu">
              <Pause className="size-3.5" aria-hidden />
              <span>
                <b className="font-semibold">Paused</b>{" "}
                <span className="text-fg-secondary">
                  · {newSincePause.toLocaleString()} new lines since {pausedAt?.time}
                </span>
              </span>
              <Button size="sm" variant="primary" onClick={resume}>
                <ArrowDown aria-hidden />
                Jump to live
              </Button>
              <Kbd>End</Kbd>
            </div>
          )}
        </div>

        <div className="flex h-7 shrink-0 items-center gap-3.5 overflow-hidden whitespace-nowrap border-t border-line bg-surface-panel px-3.5 text-meta text-fg-muted dark:bg-transparent">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-status-healthy" />
            {live} live
          </span>
          {reconnecting.map((s) => (
            <span key={s.tag} className="flex items-center gap-1.5 text-status-warning">
              <span className="size-1.5 rounded-full shadow-[inset_0_0_0_1.5px_var(--status-warning)]" />
              1 reconnecting ({s.tag}
              {s.note ? ` · ${s.note}` : ""})
            </span>
          ))}
          {ended.map((s) => (
            <span key={s.tag} className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full shadow-[inset_0_0_0_1.5px_var(--fg-muted)]" />
              1 ended ({s.tag}
              {s.note ? ` · ${s.note}` : ""})
            </span>
          ))}
          <div className="flex-1" />
          <span className="hidden min-[1360px]:inline">
            Search scans the {buffer.current.length.toLocaleString()} buffered lines · ‘Fetch full log’ reads more from the API
          </span>
        </div>
      </main>
    </div>
  );
}

function StreamState({ source, enabled }: { source: LogSource; enabled: boolean }) {
  if (!enabled) return <span className="text-meta text-fg-muted">off</span>;
  const map: Record<LogSource["state"], ReactNode> = {
    live: (
      <span className="flex items-center gap-1.5 text-label text-status-healthy">
        <span className="size-1.5 rounded-full bg-status-healthy" />
        live
      </span>
    ),
    reconnecting: <span className="text-label text-status-warning">reconnecting</span>,
    ended: <span className="text-label text-fg-muted">ended · back-off</span>,
    off: <span className="text-meta text-fg-muted">off</span>,
  };
  return <>{map[source.state]}</>;
}

function ToggleIcon({ label, pressed, onClick, children }: { label: string; pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip content={`${label} ${pressed ? "on" : "off"}`}>
      <IconButton aria-label={label} aria-pressed={pressed} onClick={onClick} className={cn(pressed && "bg-surface-hover text-fg")}>
        {children}
      </IconButton>
    </Tooltip>
  );
}
