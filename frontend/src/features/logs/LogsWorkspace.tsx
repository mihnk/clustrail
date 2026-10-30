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
  X,
} from "lucide-react";
import { useWorkspace, type WorkspaceTab } from "@/app/workspace";
import { backend, EVENTS, onEvent, type LogBatch, type LogSourceSpec } from "@/backend/client";
import type { DeploymentRow, PodRow } from "@/data/types";
import { useLogLineLimit } from "./budget";
import { usePersistentState } from "@/app/preferences";
import {
  checkoutSources,
  initialBuffer,
  nextLines,
  podTag,
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
import { AddSourceDialog } from "./AddSourceDialog";
import { t as tt } from "@/i18n";

const RANGES = ["5m", "15m", "1h", "6h", "all"] as const;
const RANGE_SECONDS: Record<(typeof RANGES)[number], number> = { "5m": 300, "15m": 900, "1h": 3600, "6h": 21600, all: 0 };
/** Split view shows at most this many pods side by side. */
const SPLIT_MAX = 6;
/** Pod owners the backend can turn into a selector (internal/kube/logsources.go). */
const WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"]);

const clockOf = (iso?: string) => (iso ? new Date(iso).toTimeString().slice(0, 8) : undefined);

/**
 * What a Logs tab follows on the desktop: its selector, its workload (found
 * through the Deployment list or the pods' owner), or the one pod.
 */
export function initialSpecs(params: Record<string, string> | undefined, cluster: string | undefined, pods: PodRow[], deployments: DeploymentRow[]): LogSourceSpec[] {
  const p = params ?? {};
  const namespace = p.namespace ?? "";
  if (p.selector) return [{ namespace, selector: p.selector }];
  if (p.kind && p.workload) return [{ namespace, workload: `${p.kind}/${p.workload}` }];
  if (p.workload) {
    if (deployments.some((d) => d.cluster === cluster && d.namespace === namespace && d.name === p.workload)) return [{ namespace, workload: `Deployment/${p.workload}` }];
    const owned = pods.find((x) => x.cluster === cluster && x.namespace === namespace && x.owner?.name === p.workload);
    if (owned?.owner && WORKLOAD_KINDS.has(owned.owner.kind)) return [{ namespace, workload: `${owned.owner.kind}/${p.workload}` }];
  }
  const pod = p.pod ?? p.workload;
  return pod ? [{ namespace, pods: [pod] }] : [];
}

function specLabel(s: LogSourceSpec): string {
  if (s.workload) return s.workload;
  if (s.selector) return s.selector;
  return s.pods?.length === 1 ? `Pod/${s.pods[0]}` : tt("{n} pods", { n: s.pods?.length ?? 0 });
}

/**
 * Logs of a workload's pods: merged by timestamp or split per pod, follow
 * mode, search, bounded buffer. Pausing stops the display, not ingestion.
 */
export function LogsWorkspace({ tab, active }: { tab: WorkspaceTab; active: boolean }) {
  const ws = useWorkspace();
  const cluster = tab.cluster ? ws.clusterById(tab.cluster) : undefined;
  const workload = tab.params?.workload ?? "checkout-api";
  const namespace = tab.params?.namespace ?? "payments";
  const [bufferSetting] = usePersistentState("logs.bufferLines", 100_000);
  // The per-stream buffer, lowered when many log tabs share Settings › Total log memory.
  const bufferLimit = useLogLineLimit(tab.id, bufferSetting);

  const [maxPods] = usePersistentState("logs.maxPods", 30);
  // Desktop: what the stream follows; "Add source" appends, a source's × removes it. Mock: the checkout-api design.
  const [specs, setSpecs] = useState<LogSourceSpec[]>(() => (backend ? initialSpecs(tab.params, tab.cluster, ws.allPods, ws.deployments) : []));
  const specsKey = JSON.stringify(specs);
  const [followNew, setFollowNew] = useState(true);
  const [hideLeft, setHideLeft] = useState(false);
  const [adding, setAdding] = useState(false);
  const [counts, setCounts] = useState({ matched: 0, skipped: 0 });
  const [sources, setSources] = useState<LogSource[]>(() => (backend ? [] : checkoutSources));
  // Sources are on unless turned off, so pods that join show up.
  const [disabled, setDisabled] = useState<Set<SourceTag>>(() => (backend ? new Set() : new Set(["D"])));
  const isOn = (tag: SourceTag) => !disabled.has(tag);
  const [containers, setContainers] = useState<Record<string, Set<string>>>(
    (): Record<string, Set<string>> => (backend ? {} : { A: new Set(["api"]), B: new Set(["api"]), C: new Set(["api"]), D: new Set(["api"]) }),
  );
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
  const buffer = useRef<LogLine[]>(backend ? [] : initialBuffer());
  const [version, setVersion] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [paused, setPaused] = useState(!backend);
  const [pausedAt, setPausedAt] = useState<{ count: number; time: string } | null>(backend ? null : { count: buffer.current.length, time: "12:01:17" });
  const nextId = useRef(buffer.current.length);

  // Desktop: one backend stream for all sources; restarted when the sources, instance or range change.
  useEffect(() => {
    if (!backend || !tab.cluster || !specs.length) return;
    const api = backend;
    // Tags stay with a pod for the life of the stream: ns/pod → tag.
    const tagOf = new Map<string, SourceTag>();
    const taken = new Set<string>();
    const tagFor = (ns: string, pod: string): SourceTag => {
      const key = `${ns}/${pod}`;
      let tag = tagOf.get(key);
      if (!tag) {
        tag = pod ? podTag(pod, taken) : "!";
        taken.add(tag);
        tagOf.set(key, tag);
      }
      return tag;
    };
    const defaultNs = specs[0]?.namespace ?? namespace;
    setSources([]);
    setContainers({});
    setCounts({ matched: 0, skipped: 0 });
    buffer.current = [];
    nextId.current = 0;
    setDropped(0);
    setVersion((v) => v + 1);
    let streamId: string | null = null;
    let stopped = false;
    const early: LogBatch[] = [];
    const ingest = (b: LogBatch) => {
      if (b.pods) {
        const members = b.pods;
        setSources((ss) => {
          const prev = new Map(ss.map((x) => [`${x.namespace}/${x.pod}`, x]));
          return members.map((m) => {
            const old = prev.get(`${m.namespace}/${m.pod}`);
            const left = m.state === "left";
            return {
              tag: tagFor(m.namespace, m.pod),
              pod: m.pod,
              namespace: m.namespace,
              containers: old?.containers ?? [],
              state: left ? "left" : old && old.state !== "left" ? old.state : "live",
              note: left ? m.reason : old?.note,
              revision: m.revision,
              joined: m.initial ? undefined : clockOf(m.joined),
              left: clockOf(m.left),
            };
          });
        });
      }
      if (b.matched !== undefined) setCounts((c) => (c.matched === b.matched && c.skipped === (b.skipped ?? 0) ? c : { matched: b.matched ?? 0, skipped: b.skipped ?? 0 }));
      const seen: Record<string, Set<string>> = {};
      const lines = b.lines.map<LogLine>((l) => {
        const tag = tagFor(l.namespace ?? defaultNs, l.pod);
        if (l.container) (seen[tag] ??= new Set()).add(l.container);
        return { id: nextId.current++, ts: l.ts, tag, container: l.container, level: l.level, msg: l.msg, event: l.event ? { health: l.event } : undefined };
      });
      const buf = buffer.current;
      buf.push(...lines);
      if (buf.length > bufferLimit) {
        const over = buf.length - bufferLimit;
        buf.splice(0, over);
        setDropped((d) => d + over);
      }
      // New containers show up as they first log; they are on by default.
      if (Object.keys(seen).length) {
        setContainers((cur) => {
          let changed = false;
          const next = { ...cur };
          for (const [tag, set] of Object.entries(seen)) {
            for (const c of set) {
              if (!next[tag]?.has(c)) {
                next[tag] = new Set([...(next[tag] ?? []), c]);
                changed = true;
              }
            }
          }
          return changed ? next : cur;
        });
      }
      if (b.states?.length || Object.keys(seen).length) {
        setSources((ss) =>
          ss.map((src) => {
            const states = (b.states ?? []).filter((st) => st.pod === src.pod && (st.namespace ?? defaultNs) === src.namespace);
            const names = [...new Set([...src.containers, ...states.map((st) => st.container), ...(seen[src.tag] ?? [])])];
            if (!states.length || src.state === "left") return names.length === src.containers.length ? src : { ...src, containers: names };
            const state = states.some((st) => st.state === "live") ? "live" : states.some((st) => st.state === "reconnecting") ? "reconnecting" : "ended";
            return { ...src, containers: names, state, note: states.find((st) => st.note)?.note };
          }),
        );
      }
      setVersion((v) => v + 1);
    };
    const off = onEvent<LogBatch>(EVENTS.logs, (b) => {
      if (streamId === null) early.push(b);
      else if (b.id === streamId) ingest(b);
    });
    void api
      .startLogs({
        cluster: tab.cluster,
        namespace: defaultNs,
        pods: [],
        sources: specs,
        containers: [],
        previous: instance === "previous",
        sinceSeconds: RANGE_SECONDS[range],
        tailLines: range === "all" ? 10_000 : 0,
        maxPods,
        followNew,
      })
      .then((id) => {
        if (stopped) return void api.stopLogs(id);
        streamId = id;
        early.filter((b) => b.id === id).forEach(ingest);
      });
    return () => {
      stopped = true;
      off();
      if (streamId) void api.stopLogs(streamId);
    };
  }, [specsKey, instance, range, tab.cluster, followNew, maxPods]);

  useEffect(() => {
    if (backend) return;
    // Source x2kqp comes back as a new instance after a few seconds.
    const reconnect = setTimeout(
      () => setSources((ss) => ss.map((s) => (s.tag === "A" ? { ...s, state: "live", note: undefined } : s))),
      6000,
    );
    return () => clearTimeout(reconnect);
  }, []);

  useEffect(() => {
    if (backend) return;
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
      instance === "previous" && !backend ? sources.filter((x) => isOn(x.tag)).flatMap((x) => previousInstance(x.tag)) : buffer.current.slice(0, visibleCount);
    const gone = hideLeft ? new Set(sources.filter((x) => x.state === "left").map((x) => x.tag)) : null;
    return src.filter(
      (l) =>
        !disabled.has(l.tag) &&
        !gone?.has(l.tag) &&
        (l.event || containers[l.tag]?.has(l.container)) &&
        (!onlyMatching || !matcher || l.event || (matcher.lastIndex = 0, matcher.test(l.msg))),
    );
  }, [version, visibleCount, disabled, containers, instance, onlyMatching, matcher, hideLeft, sources]);

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

  const live = sources.filter((s) => isOn(s.tag) && s.state === "live").length;
  const reconnecting = sources.filter((s) => isOn(s.tag) && s.state === "reconnecting");
  const ended = sources.filter((s) => isOn(s.tag) && s.state === "ended");
  const leftCount = sources.filter((s) => s.state === "left").length;
  const following = sources.length - leftCount;
  const splitTags = sources.filter((s) => isOn(s.tag) && !(hideLeft && s.state === "left")).map((s) => s.tag).slice(0, SPLIT_MAX);
  // ~260 bytes per buffered line.
  const bytes = ((buffer.current.length * 260) / 1e6).toFixed(1);
  const sourceOf = (tag: SourceTag) => sources.find((s) => s.tag === tag);

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-label={tt("Log sources")} className="flex w-[264px] shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-line bg-surface-panel px-2.5 py-3">
        <div className="flex items-center px-1">
          <span className="section-label flex-1">{tt("Sources")}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!backend || !tab.cluster}
            title={backend ? undefined : tt("Sources come from your clusters in the desktop app.")}
            onClick={() => setAdding(true)}
          >
            <Plus aria-hidden />{tt("Add source")}</Button>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg border border-line p-2">
          {backend ? (
            specs.map((sp, i) => (
              <div key={`${i}:${specLabel(sp)}`} className="flex items-center gap-1.5 text-ui">
                <Layers className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono font-semibold" title={`${sp.namespace} · ${specLabel(sp)}`}>
                  {specLabel(sp)}
                </span>
                {i === 0 && cluster && <EnvironmentBadge env={cluster.env} />}
                {specs.length > 1 && (
                  <IconButton aria-label={tt("Remove source {v0}", { v0: specLabel(sp) })} className="size-5 [&_svg]:size-3" onClick={() => setSpecs(specs.filter((_, j) => j !== i))}>
                    <X />
                  </IconButton>
                )}
              </div>
            ))
          ) : (
            <div className="flex items-center gap-1.5 text-ui">
              <Layers className="size-3.5 text-fg-muted" aria-hidden />
              <span className="truncate font-mono font-semibold">{workload}</span>
              {cluster && <EnvironmentBadge env={cluster.env} className="ml-auto" />}
            </div>
          )}
          <span className="pb-1.5 pl-5 text-meta text-fg-muted">
            {[...new Set(backend ? specs.map((sp) => sp.namespace) : [namespace])].join(", ")} · {tab.cluster} ·{" "}
            {backend ? tt("following {n} of {m} pods", { n: following, m: Math.max(counts.matched, following) }) : tt("{n} pods", { n: sources.length })}
            {counts.skipped > 0 && <span className="text-status-warning">{" · "}{tt("{n} skipped (limit {max})", { n: counts.skipped, max: maxPods })}</span>}
          </span>
          {backend && sources.length === 0 && <span className="pl-5 text-meta text-fg-muted">{tt("Waiting for matching pods…")}</span>}
          {sources.map((s) => (
            <div key={s.tag}>
              <label className={cn("flex h-7 cursor-pointer items-center gap-2 rounded-md px-1.5 text-ui", s.state === "left" && "opacity-60")}>
                <Checkbox
                  checked={isOn(s.tag)}
                  aria-label={tt("Include {pod}", { pod: s.pod })}
                  onCheckedChange={(on) => {
                    const next = new Set(disabled);
                    if (on) next.delete(s.tag);
                    else next.add(s.tag);
                    setDisabled(next);
                  }}
                />
                <TagChip tag={s.tag} />
                <span className={cn("min-w-0 flex-1 truncate font-mono", !isOn(s.tag) && "text-fg-secondary")} title={[s.pod, s.revision && `rev ${s.revision}`, s.joined && tt("joined {time}", { time: s.joined })].filter(Boolean).join(" · ")}>
                  {s.tag.length > 1 ? <span className="text-fg-muted">{s.pod.slice(0, Math.max(0, s.pod.length - s.tag.length))}</span> : "…"}
                  {s.tag.length > 1 ? s.tag : s.pod.split("-").pop()}
                </span>
                <StreamState source={s} enabled={isOn(s.tag)} />
              </label>
              {isOn(s.tag) && s.state !== "left" && s.containers.length > 1 && (
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
        {backend && (
          <div className="flex flex-col gap-1.5 px-1">
            <label className="flex items-center gap-2 text-ui text-fg-secondary">
              <Checkbox checked={followNew} aria-label={tt("Follow pods that start later")} onCheckedChange={(on) => setFollowNew(on === true)} />
              {tt("Follow pods that start later")}
            </label>
            <label className="flex items-center gap-2 text-ui text-fg-secondary">
              <Checkbox checked={hideLeft} aria-label={tt("Hide lines of pods that left")} onCheckedChange={(on) => setHideLeft(on === true)} />
              {tt("Hide lines of pods that left")}
            </label>
          </div>
        )}
        <div className="flex flex-col gap-1.5 px-1">
          <span className="section-label">{tt("Container instance")}</span>
          <Segmented
            aria-label={tt("Instance")}
            value={instance}
            onValueChange={setInstance}
            options={[
              { value: "current", label: tt("Current") },
              { value: "previous", label: <><History className="size-3.5" aria-hidden />{tt("Previous")}</> },
            ]}
          />
          <span className="text-meta leading-[1.4] text-fg-muted">{tt("Previous shows the last terminated instance only — Kubernetes keeps one.")}</span>
        </div>
        <div className="flex flex-col gap-1.5 px-1">
          <span className="section-label">{tt("Range")}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="focus-ring flex h-[26px] items-center justify-between rounded-md border border-line-strong bg-transparent px-2 text-ui text-fg">
                <span>
                  <span className="text-fg-muted">{tt("since")}</span> {range}
                </span>
                <ChevronDown className="size-3.5 text-fg-muted" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>{tt("Since")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={range} onValueChange={(v) => setRange(v as typeof range)}>
                {RANGES.map((r) => (
                  <DropdownMenuRadioItem key={r} value={r}>
                    {r === "all" ? tt("everything the API keeps") : r}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex-1" />
        <div className="flex flex-col gap-1 rounded-lg bg-surface-app p-2 text-meta">
          <div className="flex">
            <span className="flex-1 text-fg-secondary">{tt("Buffer")}</span>
            <span className="font-mono">
              {buffer.current.length.toLocaleString()} / {bufferLimit.toLocaleString()}{" "}{tt("lines")}</span>
          </div>
          <Meter value={buffer.current.length / bufferLimit} label={tt("Buffer used")} className="flex-none" />
          <div className="flex text-fg-muted">
            <span className="flex-1">
              {tt("{bytes} MB · oldest {v1}", { bytes, v1: buffer.current[0]?.ts.slice(0, 8) })}
            </span>
            <span>{dropped.toLocaleString()}{" "}{tt("dropped")}</span>
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-surface-app">
        <div className="flex h-[46px] shrink-0 items-center gap-1.5 border-b border-line bg-surface-panel pl-3.5 pr-3 dark:bg-transparent">
          {paused ? (
            <Button variant="primary" onClick={resume}>
              <Play aria-hidden />{tt("Resume")}</Button>
          ) : (
            <Button onClick={pause}>
              <Pause aria-hidden />{tt("Pause")}</Button>
          )}
          <Segmented
            aria-label={tt("Layout")}
            value={layout}
            onValueChange={setLayout}
            options={[
              { value: "merged", label: tt("Merged") },
              { value: "split", label: <><Columns2 className="size-3.5" aria-hidden />{tt("Split")}</> },
            ]}
          />
          <ToggleIcon label={tt("Timestamps")} pressed={showTs} onClick={() => setShowTs(!showTs)}>
            <Clock />
          </ToggleIcon>
          <ToggleIcon label={tt("Wrap lines")} pressed={wrap} onClick={() => setWrap(!wrap)}>
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
            <span className="sr-only">{tt("Search logs")}</span>
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
              placeholder={tt("Search buffered lines")}
              spellCheck={false}
              className="min-w-0 flex-1 border-0 bg-transparent font-mono text-cell text-fg outline-none placeholder:font-sans placeholder:text-fg-muted"
            />
            {query && (
              <span className="whitespace-nowrap font-mono text-label text-fg-secondary">
                {regexError ? "invalid" : matches.length ? `${Math.min(matchPos, matches.length - 1) + 1} / ${matches.length}` : "0"}
              </span>
            )}
            <IconButton aria-label={tt("Previous match")} className="size-5 [&_svg]:size-3.5" onClick={() => setMatchPos((p) => (matches.length ? (p - 1 + matches.length) % matches.length : 0))}>
              <ChevronUp />
            </IconButton>
            <IconButton aria-label={tt("Next match")} className="size-5 [&_svg]:size-3.5" onClick={() => setMatchPos((p) => (matches.length ? (p + 1) % matches.length : 0))}>
              <ChevronDown />
            </IconButton>
          </label>
          <button
            type="button"
            aria-pressed={regex}
            onClick={() => setRegex(!regex)}
            title={tt("Regular expression")}
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
            <Filter className="size-3.5" aria-hidden />{tt("Only matching")}</button>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            disabled={selectedLine === null}
            title={selectedLine === null ? tt("Click a line to select it") : undefined}
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
            <Pin aria-hidden />{tt("Pin selection")}</Button>
          <IconButton
            aria-label={tt("Copy visible lines")}
            onClick={() => void navigator.clipboard?.writeText(lines.slice(-200).map((l) => `${l.ts} ${l.tag} ${l.level} ${l.msg}`).join("\n"))}
          >
            <Copy />
          </IconButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <Download aria-hidden />{tt("Export")}<ChevronDown aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={exportBuffer}>{tt("Save buffer as .log…")}</DropdownMenuItem>
              <DropdownMenuItem disabled>{tt("Fetch full log from the API")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="relative flex min-h-0 flex-1">
          {layout === "merged" ? (
            <LogView
              label={tt("Merged log stream")}
              lines={lines}
              tagWidth={backend ? 52 : 22}
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
            <div className="grid min-h-0 flex-1 gap-px bg-line" style={{ gridTemplateColumns: `repeat(${Math.max(1, splitTags.length)}, minmax(0, 1fr))` }}>
              {splitTags.map((tag) => (
                <div key={tag} className="flex min-h-0 flex-col bg-term-bg">
                  <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line px-3 font-mono text-ui text-fg-secondary">
                    <TagChip tag={tag} />
                    …{sourceOf(tag)?.pod.split("-").pop()}
                  </div>
                  <LogView
                    label={tt("Logs of {v0}", { v0: sourceOf(tag)?.pod })}
                    lines={lines.filter((l) => l.tag === tag)}
                    tagWidth={backend ? 52 : 22}
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
                <b className="font-semibold">{tt("Paused")}</b>{" "}
                <span className="text-fg-secondary">{tt("· {v0} new lines since {time}", { v0: newSincePause.toLocaleString(), time: pausedAt?.time })}
                </span>
              </span>
              <Button size="sm" variant="primary" onClick={resume}>
                <ArrowDown aria-hidden />{tt("Jump to live")}</Button>
              <Kbd>{tt("End")}</Kbd>
            </div>
          )}
        </div>

        <div className="flex h-7 shrink-0 items-center gap-3.5 overflow-hidden whitespace-nowrap border-t border-line bg-surface-panel px-3.5 text-meta text-fg-muted dark:bg-transparent">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-status-healthy" />
            {live}{" "}{tt("live")}</span>
          {reconnecting.map((s) => (
            <span key={s.tag} className="flex items-center gap-1.5 text-status-warning">
              <span className="size-1.5 rounded-full shadow-[inset_0_0_0_1.5px_var(--status-warning)]" />{tt("1 reconnecting (")}{s.tag}
              {s.note ? ` · ${s.note}` : ""})
            </span>
          ))}
          {ended.map((s) => (
            <span key={s.tag} className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full shadow-[inset_0_0_0_1.5px_var(--fg-muted)]" />{tt("1 ended (")}{s.tag}
              {s.note ? ` · ${s.note}` : ""})
            </span>
          ))}
          {leftCount > 0 && <span>{tt("{n} left", { n: leftCount })}</span>}
          {counts.skipped > 0 && <span className="text-status-warning">{tt("{n} pods not followed (limit {max})", { n: counts.skipped, max: maxPods })}</span>}
          <div className="flex-1" />
          <span className="hidden min-[1360px]:inline">{tt("Search scans the {v0} buffered lines · ‘Fetch full log’ reads more from the API", { v0: buffer.current.length.toLocaleString() })}</span>
        </div>
      </main>
      {adding && tab.cluster && (
        <AddSourceDialog
          cluster={tab.cluster}
          namespace={specs[0]?.namespace ?? namespace}
          maxPods={maxPods}
          onAdd={(spec) => setSpecs((cur) => [...cur, spec])}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function StreamState({ source, enabled }: { source: LogSource; enabled: boolean }) {
  if (!enabled) return <span className="text-meta text-fg-muted">{tt("off")}</span>;
  const map: Record<LogSource["state"], ReactNode> = {
    live: (
      <span className="flex items-center gap-1.5 text-label text-status-healthy">
        <span className="size-1.5 rounded-full bg-status-healthy" />{tt("live")}</span>
    ),
    reconnecting: <span className="text-label text-status-warning">{tt("reconnecting")}</span>,
    ended: <span className="text-label text-fg-muted">{tt("ended · back-off")}</span>,
    off: <span className="text-meta text-fg-muted">{tt("off")}</span>,
    left: <span className="text-label text-fg-muted" title={source.note}>{source.left ? tt("left {time}", { time: source.left }) : tt("left")}</span>,
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
