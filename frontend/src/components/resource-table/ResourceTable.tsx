import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { flexRender, type Column, type RowData, type Table } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/cn";

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Column label for menus and the "hidden" note. */
    label: string;
    /** Fixed px width, or "fill" for the one flexible column. */
    width: number | "fill";
    align?: "right";
    /** Lower priorities are hidden first when the table gets narrow. 100 = never. */
    priority: number;
    /** Text for the sorted-by note in the table footer. */
    sortNote?: string;
  }
}

const GAP = 8;
const PAD_X = 12;
const FILL_MIN = 220;
const OVERSCAN = 12;

export interface ResourceTableProps<T> {
  table: Table<T>;
  rowHeight: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Enter or double click. */
  onOpen?: (id: string) => void;
  /** Escape. */
  onDismiss?: () => void;
  /** Labels of columns hidden because the table is too narrow. */
  onAutoHiddenChange?: (labels: string[]) => void;
  "aria-label": string;
  empty?: ReactNode;
}

/**
 * Virtualized, keyboard-navigable resource table. Only the rows in view (plus
 * a small overscan) are in the DOM, rows keep a stable identity, and cells are
 * plain text so watch updates re-render only the rows that changed.
 */
export function ResourceTable<T>({
  table,
  rowHeight,
  selectedId,
  onSelect,
  onOpen,
  onDismiss,
  onAutoHiddenChange,
  "aria-label": ariaLabel,
  empty,
}: ResourceTableProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(rootRef);

  const visible = table.getVisibleLeafColumns();
  const columns = useMemo(() => fitColumns(visible, width), [visible, width]);
  const autoHidden = useMemo(
    () => visible.filter((c) => !columns.includes(c)).map((c) => c.columnDef.meta?.label ?? c.id),
    [visible, columns],
  );
  const autoHiddenKey = autoHidden.join("|");
  // Report only when the set of hidden columns changes.
  useEffect(() => onAutoHiddenChange?.(autoHidden), [autoHiddenKey]);

  const gridTemplateColumns = columns
    .map((c) => (c.columnDef.meta?.width === "fill" ? "minmax(0,1fr)" : `${c.columnDef.meta?.width ?? 80}px`))
    .join(" ");
  const gridStyle = { gridTemplateColumns, columnGap: GAP, paddingInline: PAD_X };

  const rows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    getItemKey: (i) => rows[i]?.id ?? i,
  });
  useLayoutEffect(() => virtualizer.measure(), [rowHeight, virtualizer]);

  const selectedIndex = selectedId === null ? -1 : rows.findIndex((r) => r.id === selectedId);

  const moveTo = (index: number) => {
    const i = Math.max(0, Math.min(rows.length - 1, index));
    const row = rows[i];
    if (!row) return;
    onSelect(row.id);
    virtualizer.scrollToIndex(i, { align: "auto" });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? rowHeight) / rowHeight) - 1);
    switch (e.key) {
      case "ArrowDown":
        moveTo(selectedIndex + 1);
        break;
      case "ArrowUp":
        moveTo(selectedIndex <= 0 ? 0 : selectedIndex - 1);
        break;
      case "PageDown":
        moveTo(selectedIndex + page);
        break;
      case "PageUp":
        moveTo(selectedIndex - page);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(rows.length - 1);
        break;
      case "Enter":
        if (selectedId) onOpen?.(selectedId);
        break;
      case "Escape":
        onDismiss?.();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const items = virtualizer.getVirtualItems();
  const activeRendered = items.some((v) => v.index === selectedIndex);

  return (
    <div ref={rootRef} role="grid" aria-label={ariaLabel} aria-rowcount={rows.length + 1} className="flex min-h-0 flex-1 flex-col">
      <div role="row" className="grid h-[30px] shrink-0 items-center border-b border-line text-meta font-medium text-fg-muted" style={gridStyle}>
        {columns.map((column) => (
          <HeaderCell key={column.id} column={column} />
        ))}
      </div>

      <div
        ref={scrollRef}
        tabIndex={0}
        aria-activedescendant={activeRendered ? rowDomId(selectedIndex) : undefined}
        onKeyDown={onKeyDown}
        className="focus-ring min-h-0 flex-1 overflow-y-auto overflow-x-hidden focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
      >
        {rows.length === 0 ? (
          empty
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((v) => {
              const row = rows[v.index]!;
              const selected = row.id === selectedId;
              return (
                <div
                  key={v.key}
                  id={rowDomId(v.index)}
                  role="row"
                  aria-rowindex={v.index + 2}
                  aria-selected={selected}
                  onClick={() => onSelect(row.id)}
                  onDoubleClick={() => onOpen?.(row.id)}
                  className={cn(
                    "absolute left-0 top-0 grid w-full items-center border-b border-line-row text-cell text-fg-secondary",
                    selected ? "bg-surface-selected text-fg shadow-[inset_0_0_0_1px_var(--line-selected)]" : "hover:bg-surface-hover",
                  )}
                  style={{ ...gridStyle, height: rowHeight, transform: `translateY(${v.start}px)` }}
                >
                  {columns.map((column) => {
                    const cell = row.getAllCells().find((c) => c.column.id === column.id)!;
                    return (
                      <div
                        key={column.id}
                        role="gridcell"
                        className={cn(
                          "min-w-0",
                          column.columnDef.meta?.align === "right" &&
                            "text-right font-mono text-ui tabular-nums",
                        )}
                      >
                        {flexRender(column.columnDef.cell, cell.getContext())}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function HeaderCell<T>({ column }: { column: Column<T, unknown> }) {
  const meta = column.columnDef.meta;
  const sorted = column.getIsSorted();
  const right = meta?.align === "right";
  return (
    <div
      role="columnheader"
      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
      className={cn("flex min-w-0", right && "justify-end")}
    >
      <button
        type="button"
        onClick={column.getToggleSortingHandler()}
        disabled={!column.getCanSort()}
        className={cn(
          "focus-ring flex min-w-0 items-center gap-1 whitespace-nowrap rounded-sm border-0 bg-transparent p-0 text-meta font-medium text-inherit hover:text-fg-secondary disabled:cursor-default",
          sorted && "text-fg",
        )}
      >
        <span className="truncate">{meta?.label ?? column.id}</span>
        {sorted === "asc" && <ArrowDown className="size-3 shrink-0" aria-hidden />}
        {sorted === "desc" && <ArrowUp className="size-3 shrink-0" aria-hidden />}
      </button>
    </div>
  );
}

const rowDomId = (index: number) => `resource-row-${index}`;

/** Drop the lowest-priority columns until the flexible column has room. */
function fitColumns<T>(columns: Column<T, unknown>[], width: number): Column<T, unknown>[] {
  if (width <= 0) return columns;
  const shown = [...columns];
  const required = (cs: Column<T, unknown>[]) =>
    cs.reduce((sum, c) => {
      const w = c.columnDef.meta?.width ?? 80;
      return sum + (w === "fill" ? FILL_MIN : w);
    }, 0) +
    GAP * Math.max(0, cs.length - 1) +
    PAD_X * 2;

  while (required(shown) > width) {
    let drop = -1;
    shown.forEach((c, i) => {
      const p = c.columnDef.meta?.priority ?? 50;
      if (p < 100 && (drop === -1 || p < (shown[drop]!.columnDef.meta?.priority ?? 50))) drop = i;
    });
    if (drop === -1) break;
    shown.splice(drop, 1);
  }
  return shown;
}

function useElementWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
