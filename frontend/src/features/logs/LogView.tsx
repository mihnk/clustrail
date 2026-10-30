import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { tagColor, type LogLine, type LogMarker } from "@/data/logs";
import type { Health } from "@/data/types";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { cn } from "@/lib/cn";

const LINE_HEIGHT = 19;

export function TagChip({ tag }: { tag: LogLine["tag"] }) {
  if (tag.length > 1) {
    return (
      <b className="inline-block max-w-[52px] shrink-0 truncate font-mono text-meta font-semibold not-italic" style={{ color: tagColor(tag) }} aria-label={`source ${tag}`}>
        {tag}
      </b>
    );
  }
  return (
    <b
      className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] font-mono text-[9.5px] font-semibold not-italic text-surface-app"
      style={{ background: tagColor(tag) }}
      aria-label={`source ${tag}`}
    >
      {tag}
    </b>
  );
}

const MARKER_HEALTH: Record<LogMarker, Health> = { failed: "failed", progressing: "progressing", unknown: "unknown", joined: "healthy", left: "unknown" };

/**
 * Virtualized log lines on the terminal surface. Only lines in view exist in
 * the DOM; with wrapping on, rows are measured instead of fixed-height.
 */
export function LogView({
  lines,
  showTimestamps,
  wrap,
  matcher,
  currentMatchId,
  selectedId,
  onSelect,
  follow,
  onScrollAway,
  scrollToId,
  label,
  tagWidth = 22,
}: {
  lines: LogLine[];
  showTimestamps: boolean;
  wrap: boolean;
  matcher: RegExp | null;
  currentMatchId: number | null;
  selectedId: number | null;
  onSelect: (id: number) => void;
  /** Keep the newest line in view. */
  follow: boolean;
  /** The user scrolled away from the bottom (pauses the display). */
  onScrollAway: () => void;
  scrollToId: number | null;
  label: string;
  /** Width of the source tag column: 22 for letters, wider for pod suffixes. */
  tagWidth?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 20,
    getItemKey: (i) => lines[i]?.id ?? i,
  });

  // Open at the newest lines, like a terminal.
  useLayoutEffect(() => {
    if (lines.length) {
      programmatic.current = true;
      virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
    }
  }, []);

  useLayoutEffect(() => {
    if (follow && lines.length) {
      programmatic.current = true;
      virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
    }
  }, [follow, lines.length, virtualizer]);

  useEffect(() => {
    if (scrollToId === null) return;
    const i = lines.findIndex((l) => l.id === scrollToId);
    if (i >= 0) {
      programmatic.current = true;
      virtualizer.scrollToIndex(i, { align: "center" });
    }
  }, [scrollToId]);

  useLayoutEffect(() => virtualizer.measure(), [wrap, showTimestamps, virtualizer]);

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label={label}
      aria-live="off"
      tabIndex={0}
      style={{ ["--tag-w" as string]: `${tagWidth}px` }}
      onScroll={(e) => {
        const el = e.currentTarget;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < LINE_HEIGHT * 2;
        if (programmatic.current) {
          programmatic.current = false;
          return;
        }
        if (!atBottom && follow) onScrollAway();
      }}
      className="focus-ring selectable min-h-0 flex-1 overflow-auto bg-term-bg py-1.5 font-mono text-ui text-term-fg focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => {
          const line = lines[v.index]!;
          return (
            <div
              key={v.key}
              data-index={v.index}
              ref={wrap ? virtualizer.measureElement : undefined}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${v.start}px)`, height: wrap ? undefined : LINE_HEIGHT }}
            >
              <Line
                line={line}
                showTimestamps={showTimestamps}
                wrap={wrap}
                matcher={matcher}
                current={line.id === currentMatchId}
                selected={line.id === selectedId}
                onSelect={onSelect}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const Line = memo(function Line({
  line,
  showTimestamps,
  wrap,
  matcher,
  current,
  selected,
  onSelect,
}: {
  line: LogLine;
  showTimestamps: boolean;
  wrap: boolean;
  matcher: RegExp | null;
  current: boolean;
  selected: boolean;
  onSelect: (id: number) => void;
}) {
  if (line.event) {
    return (
      <div className="flex h-[19px] items-center gap-2.5 px-3.5 font-sans text-meta font-medium text-fg-secondary before:h-px before:flex-1 before:bg-line-strong after:h-px after:flex-1 after:bg-line-strong">
        <StatusGlyph health={MARKER_HEALTH[line.event.health]} />
        <TagChip tag={line.tag} />
        {line.msg}
      </div>
    );
  }
  return (
    <div
      onClick={() => onSelect(line.id)}
      className={cn(
        "grid gap-x-2.5 px-3.5 leading-[19px]",
        showTimestamps ? "grid-cols-[92px_var(--tag-w,22px)_minmax(0,1fr)]" : "grid-cols-[var(--tag-w,22px)_minmax(0,1fr)]",
        selected && "bg-accent-soft",
      )}
    >
      {showTimestamps && <span className="text-fg-muted">{line.ts}</span>}
      <span className="flex items-center">
        <TagChip tag={line.tag} />
      </span>
      <span
        className={cn(
          wrap ? "whitespace-pre-wrap break-all" : "truncate whitespace-pre",
          line.level === "ERROR" && "text-status-critical",
          line.level === "WARN" && "text-status-warning",
        )}
      >
        {line.level && <span className={cn(line.level === "INFO" && "text-fg-muted")}>{line.level.padEnd(7)}</span>}
        <Highlighted text={line.msg} matcher={matcher} current={current} />
      </span>
    </div>
  );
});

function Highlighted({ text, matcher, current }: { text: string; matcher: RegExp | null; current: boolean }) {
  if (!matcher) return <>{text}</>;
  const parts: (string | { hit: string })[] = [];
  let last = 0;
  matcher.lastIndex = 0;
  for (let m = matcher.exec(text); m; m = matcher.exec(text)) {
    if (m[0] === "") {
      matcher.lastIndex++;
      continue;
    }
    parts.push(text.slice(last, m.index), { hit: m[0] });
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          p
        ) : (
          <mark
            key={i}
            className={cn(
              "rounded-sm text-fg",
              current ? "bg-status-warning text-[#1A1204]" : "bg-highlight shadow-[0_0_0_1px_var(--highlight)]",
            )}
          >
            {p.hit}
          </mark>
        ),
      )}
    </>
  );
}
