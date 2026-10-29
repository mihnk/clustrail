import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { flexRender, type Column, type Row, type RowData, type Table } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from "lucide-react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  ResourceContextMenuContent,
  type ActionTarget,
  type ResourceAction,
} from "@/components/resource-actions/ResourceActions";
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

const FILL_MIN = 220;
const OVERSCAN = 12;
const GROUP_HEIGHT = 32;

export interface ResourceTableGrouping<T> {
  /** Group keys in display order. Groups without rows still show their header. */
  keys: string[];
  keyOf: (row: T) => string;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** Header content after the chevron. */
  renderHeader: (key: string, rows: T[]) => ReactNode;
}

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
  /** Right-click menu for a row; the row is selected when the menu opens. */
  rowActions?: (id: string) => { actions: ResourceAction[]; target: ActionTarget } | null;
  /** Section rows (e.g. one per cluster); sorting applies within each group. */
  grouping?: ResourceTableGrouping<T>;
  /** Grid spacing; 8/12 for explorers, wider for single-cluster lists. */
  columnGap?: number;
  paddingX?: number;
  "aria-label": string;
  empty?: ReactNode;
}

type Item<T> = { kind: "group"; key: string; rows: Row<T>[] } | { kind: "row"; row: Row<T> };

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
  rowActions,
  grouping,
  columnGap = 8,
  paddingX = 12,
  "aria-label": ariaLabel,
  empty,
}: ResourceTableProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [menuRowId, setMenuRowId] = useState<string | null>(null);
  const menu = menuRowId && rowActions ? rowActions(menuRowId) : null;
  const width = useElementWidth(rootRef);

  const visible = table.getVisibleLeafColumns();
  const columns = useMemo(() => fitColumns(visible, width, columnGap, paddingX), [visible, width, columnGap, paddingX]);
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
  const gridStyle = { gridTemplateColumns, columnGap, paddingInline: paddingX };

  const rows = table.getRowModel().rows;
  const items = useMemo<Item<T>[]>(() => {
    if (!grouping) return rows.map((row) => ({ kind: "row", row }));
    const byKey = new Map<string, Row<T>[]>(grouping.keys.map((k) => [k, []]));
    for (const row of rows) byKey.get(grouping.keyOf(row.original))?.push(row);
    return grouping.keys.flatMap((key) => {
      const groupRows = byKey.get(key) ?? [];
      const header: Item<T> = { kind: "group", key, rows: groupRows };
      return grouping.collapsed.has(key) ? [header] : [header, ...groupRows.map((row) => ({ kind: "row" as const, row }))];
    });
  }, [rows, grouping]);

  // Keyboard navigation moves between rows only, skipping group headers.
  const rowPositions = useMemo(() => items.flatMap((it, i) => (it.kind === "row" ? [i] : [])), [items]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i]?.kind === "group" ? GROUP_HEIGHT : rowHeight),
    overscan: OVERSCAN,
    getItemKey: (i) => {
      const it = items[i];
      return it ? (it.kind === "group" ? `group:${it.key}` : it.row.id) : i;
    },
  });
  useLayoutEffect(() => virtualizer.measure(), [rowHeight, items, virtualizer]);

  const selectedItem = selectedId === null ? -1 : items.findIndex((it) => it.kind === "row" && it.row.id === selectedId);
  const selectedPos = rowPositions.indexOf(selectedItem);

  const moveTo = (pos: number) => {
    const p = Math.max(0, Math.min(rowPositions.length - 1, pos));
    const itemIndex = rowPositions[p];
    const it = itemIndex === undefined ? undefined : items[itemIndex];
    if (!it || it.kind !== "row") return;
    onSelect(it.row.id);
    virtualizer.scrollToIndex(itemIndex!, { align: "auto" });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? rowHeight) / rowHeight) - 1);
    switch (e.key) {
      case "ArrowDown":
        moveTo(selectedPos + 1);
        break;
      case "ArrowUp":
        moveTo(selectedPos <= 0 ? 0 : selectedPos - 1);
        break;
      case "PageDown":
        moveTo(selectedPos + page);
        break;
      case "PageUp":
        moveTo(selectedPos - page);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(rowPositions.length - 1);
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

  const virtualItems = virtualizer.getVirtualItems();
  const activeRendered = virtualItems.some((v) => v.index === selectedItem);

  return (
    <div ref={rootRef} role="grid" aria-label={ariaLabel} aria-rowcount={items.length + 1} className="flex min-h-0 flex-1 flex-col">
      <div
        role="row"
        className="grid h-[30px] shrink-0 items-center border-b border-line bg-surface-panel text-meta font-medium text-fg-muted dark:bg-transparent"
        style={gridStyle}
      >
        {columns.map((column) => (
          <HeaderCell key={column.id} column={column} />
        ))}
      </div>

      <ContextMenu onOpenChange={(open) => !open && setMenuRowId(null)}>
        <ContextMenuTrigger asChild disabled={!rowActions}>
          <div
            ref={scrollRef}
            tabIndex={0}
            aria-activedescendant={activeRendered ? rowDomId(selectedItem) : undefined}
            onKeyDown={onKeyDown}
            onContextMenu={(e) => {
              const id = (e.target as HTMLElement).closest("[data-row-id]")?.getAttribute("data-row-id");
              if (!id || !rowActions?.(id)) {
                // Not on a row: no menu (and no native browser menu in the app).
                e.preventDefault();
                return;
              }
              onSelect(id);
              setMenuRowId(id);
            }}
            className="focus-ring min-h-0 flex-1 overflow-y-auto overflow-x-hidden focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
          >
            {rows.length === 0 && !grouping ? (
              empty
            ) : (
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualItems.map((v) => {
                  const it = items[v.index]!;
                  if (it.kind === "group") {
                    const collapsed = grouping!.collapsed.has(it.key);
                    return (
                      <div
                        key={v.key}
                        role="row"
                        aria-rowindex={v.index + 2}
                        className="absolute left-0 top-0 flex w-full items-center border-b border-line bg-surface-app"
                        style={{ height: GROUP_HEIGHT, transform: `translateY(${v.start}px)` }}
                      >
                        <div role="gridcell" className="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-cell">
                          <button
                            type="button"
                            aria-expanded={!collapsed}
                            aria-label={`${collapsed ? "Expand" : "Collapse"} ${it.key}`}
                            onClick={() => grouping!.onToggle(it.key)}
                            className="focus-ring -ml-1 inline-flex size-5 shrink-0 items-center justify-center rounded border-0 bg-transparent p-0 text-fg-muted hover:bg-surface-hover hover:text-fg"
                          >
                            {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                          </button>
                          {grouping!.renderHeader(
                            it.key,
                            it.rows.map((r) => r.original),
                          )}
                        </div>
                      </div>
                    );
                  }
                  const row = it.row;
                  const selected = row.id === selectedId;
                  return (
                    <div
                      key={v.key}
                      id={rowDomId(v.index)}
                      data-row-id={row.id}
                      role="row"
                      aria-rowindex={v.index + 2}
                      aria-selected={selected}
                      onClick={() => onSelect(row.id)}
                      onDoubleClick={() => onOpen?.(row.id)}
                      className={cn(
                        "absolute left-0 top-0 grid w-full items-center border-b border-line-row text-cell text-fg-secondary",
                        selected
                          ? "bg-surface-selected text-fg shadow-[inset_0_0_0_1px_var(--line-selected)]"
                          : "bg-surface-panel hover:bg-surface-hover dark:bg-transparent dark:hover:bg-surface-hover",
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
                              column.columnDef.meta?.align === "right" && "text-right font-mono text-ui tabular-nums",
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
            {rows.length === 0 && grouping && empty}
          </div>
        </ContextMenuTrigger>
        {menu && <ResourceContextMenuContent actions={menu.actions} target={menu.target} />}
      </ContextMenu>
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
function fitColumns<T>(columns: Column<T, unknown>[], width: number, gap: number, padX: number): Column<T, unknown>[] {
  if (width <= 0) return columns;
  const shown = [...columns];
  const required = (cs: Column<T, unknown>[]) =>
    cs.reduce((sum, c) => {
      const w = c.columnDef.meta?.width ?? 80;
      return sum + (w === "fill" ? FILL_MIN : w);
    }, 0) +
    gap * Math.max(0, cs.length - 1) +
    padX * 2;

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
