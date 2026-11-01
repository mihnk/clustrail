import { useEffect, useEffectEvent, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { LogLine } from "@/data/logs";
import { cn } from "@/lib/cn";
import { t as tt } from "@/i18n";
import { TagChip } from "./LogView";
import { lineFields, messageOf, traceOf, type FieldFilter, type FieldStat } from "./fields";

const ROW = 22;
const LEVEL_COLOR: Record<string, string> = { ERROR: "text-status-critical", WARN: "text-status-warning" };

/**
 * Structured logs: one column per chosen field, a list of the fields seen
 * with how often they appear, and the selected line's fields. A value filters
 * on click; a trace id can be followed across the namespace's pods.
 */
export function FieldsView({
  lines,
  stats,
  json,
  seen,
  columns,
  onToggleColumn,
  selectedId,
  onSelect,
  onFilter,
  onFollowTrace,
  follow,
  onScrollAway,
}: {
  lines: LogLine[];
  stats: FieldStat[];
  json: number;
  seen: number;
  columns: string[];
  onToggleColumn: (name: string) => void;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onFilter: (f: FieldFilter) => void;
  onFollowTrace: (f: FieldFilter) => void;
  follow: boolean;
  onScrollAway: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);
  const virtualizer = useVirtualizer({ count: lines.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW, overscan: 20, getItemKey: (i) => lines[i]?.id ?? i });
  const toEnd = useEffectEvent(() => {
    if (!follow || !lines.length) return;
    programmatic.current = true;
    virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
  });
  useEffect(() => toEnd(), [lines.length, follow]);

  const grid = useMemo(() => `92px 60px 56px ${columns.map(() => "minmax(90px, 1fr)").join(" ")} minmax(160px, 2fr)`, [columns]);
  const selected = selectedId === null ? undefined : lines.find((l) => l.id === selectedId);
  const selectedFields = selected ? lineFields(selected) : null;
  const trace = traceOf(selectedFields);

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-label={tt("Fields")} className="flex w-[220px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-line p-3">
        <span className="section-label">{tt("Fields in these lines")}</span>
        <span className="pb-1 text-meta text-fg-muted">{tt("{json} of the last {seen} lines are JSON", { json, seen })}</span>
        {stats.slice(0, 60).map((s) => (
          <label key={s.name} className="flex h-6 items-center gap-2 text-cell">
            <input type="checkbox" checked={columns.includes(s.name)} onChange={() => onToggleColumn(s.name)} className="accent-[var(--color-accent)]" />
            <span className="min-w-0 flex-1 truncate font-mono">{s.name}</span>
            <span className="text-meta text-fg-muted">{Math.round(s.share * 100)}%</span>
          </label>
        ))}
        {stats.length === 0 && <span className="text-meta text-fg-muted">{tt("No JSON lines yet.")}</span>}
      </aside>
      <section aria-label={tt("Log lines")} className="flex min-w-0 flex-1 flex-col">
        <div role="row" className="grid shrink-0 gap-2.5 border-b border-line px-3 py-1.5 font-mono text-meta text-fg-muted" style={{ gridTemplateColumns: grid }}>
          <span role="columnheader">{tt("time")}</span>
          <span role="columnheader">{tt("level")}</span>
          <span role="columnheader">{tt("pod")}</span>
          {columns.map((c) => (
            <span key={c} role="columnheader" className="truncate">
              {c}
            </span>
          ))}
          <span role="columnheader">{tt("msg")}</span>
        </div>
        <div
          ref={scrollRef}
          role="grid"
          aria-label={tt("Structured log lines")}
          aria-rowcount={lines.length}
          className="min-h-0 flex-1 overflow-y-auto bg-term-bg font-mono text-cell text-term-fg"
          onScroll={() => {
            if (programmatic.current) {
              programmatic.current = false;
              return;
            }
            const el = scrollRef.current;
            if (el && el.scrollHeight - el.scrollTop - el.clientHeight > ROW * 2) onScrollAway();
          }}
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((v) => {
              const l = lines[v.index]!;
              const f = lineFields(l);
              return (
                <div
                  key={v.key}
                  role="row"
                  aria-selected={l.id === selectedId}
                  onClick={() => onSelect(l.id)}
                  className={cn("absolute left-0 grid w-full cursor-default items-center gap-2.5 border-l-2 border-transparent px-3", l.id === selectedId && "border-accent bg-surface-selected")}
                  style={{ top: v.start, height: ROW, gridTemplateColumns: grid }}
                >
                  <span className="truncate text-fg-muted">{l.ts.slice(-12)}</span>
                  <span className={cn("truncate", LEVEL_COLOR[l.level] ?? "text-fg-secondary")}>{l.level}</span>
                  <span className="flex min-w-0">
                    <TagChip tag={l.tag} />
                  </span>
                  {columns.map((c) => {
                    const value = f?.[c];
                    return value === undefined ? (
                      <span key={c} className="text-fg-muted">
                        —
                      </span>
                    ) : (
                      <button key={c} type="button" title={tt("Filter on {key}={value}", { key: c, value })} onClick={(e) => (e.stopPropagation(), onFilter({ key: c, value }))} className="focus-ring truncate text-left hover:underline">
                        {value}
                      </button>
                    );
                  })}
                  <span className="truncate">{messageOf(l)}</span>
                </div>
              );
            })}
          </div>
        </div>
        {selected && (
          <div className="grid max-h-[40%] shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-4 overflow-y-auto border-t border-line bg-surface-panel px-3 py-2.5">
            <div className="flex min-w-0 flex-col gap-0.5 font-mono text-cell">
              <span className="section-label pb-1 font-sans">{tt("Selected line")}</span>
              {selectedFields ? (
                Object.entries(selectedFields).map(([k, v]) => (
                  <span key={k} className="flex min-w-0 gap-2">
                    <span className="shrink-0 text-fg-muted">{k}</span>
                    <span className="selectable min-w-0 break-all">{v}</span>
                    <button type="button" onClick={() => onFilter({ key: k, value: v })} className="focus-ring shrink-0 font-sans text-meta text-accent hover:underline">
                      {tt("filter")}
                    </button>
                  </span>
                ))
              ) : (
                <span className="selectable break-all">{selected.msg}</span>
              )}
            </div>
            {trace && (
              <button type="button" onClick={() => onFollowTrace(trace)} className="focus-ring h-7 self-start rounded-md border border-accent px-2.5 text-ui text-accent">
                {tt("Follow {key} across pods", { key: trace.key })}
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
