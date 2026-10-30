import { usePersistentState } from "@/app/preferences";
import {
  memo,
  useCallback,
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  ResourceContextMenuContent,
  type ActionTarget,
  type ResourceAction,
} from "@/components/resource-actions/ResourceActions";
import { cn } from "@/lib/cn";
import { matchesShortcut } from "@/lib/shortcuts";
import { t } from "@/i18n";

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
  /** Optional content before the chevron, e.g. a group selection checkbox. */
  renderLeading?: (key: string, rows: T[]) => ReactNode;
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
  /** Bulk selection (checkbox column): Space toggles, Shift-click selects a range, ⌘A selects all rows. */
  checked?: ReadonlySet<string>;
  onCheckedChange?: (ids: Set<string>) => void;
  /** Extra row styling, e.g. stale rows from a reconnecting cluster. */
  rowClassName?: (row: T) => string | undefined;
  /**
   * Rows update in place but keep their order while the pointer is over the
   * table; the number of rows that would move is reported.
   */
  holdOrderWhileHovered?: boolean;
  onHeldUpdatesChange?: (count: number) => void;
  /** Narrowest the flexible column may get before lower-priority columns hide. */
  fillMin?: number;
  /** Grid spacing; 8/12 for explorers, wider for single-cluster lists. */
  columnGap?: number;
  paddingX?: number;
  "aria-label": string;
  empty?: ReactNode;
  /** Rendered after the rows inside the scroll area (loading placeholders, offline cluster cards). */
  after?: ReactNode;
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
  checked,
  onCheckedChange,
  rowClassName,
  holdOrderWhileHovered,
  onHeldUpdatesChange,
  fillMin = 220,
  columnGap = 8,
  paddingX = 12,
  "aria-label": ariaLabel,
  empty,
  after,
}: ResourceTableProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [menuRowId, setMenuRowId] = useState<string | null>(null);
  const menu = menuRowId && rowActions ? rowActions(menuRowId) : null;
  const width = useElementWidth(rootRef);

  const [autoHide] = usePersistentState("settings.autoHideColumns", true);
  const visible = table.getVisibleLeafColumns();
  const columns = useMemo(
    () => (autoHide ? fitColumns(visible, width - (checked !== undefined ? 20 + columnGap : 0), columnGap, paddingX, fillMin) : visible),
    [autoHide, visible, width, columnGap, paddingX, fillMin, checked !== undefined],
  );
  const autoHidden = useMemo(
    () => visible.filter((c) => !columns.includes(c)).map((c) => c.columnDef.meta?.label ?? c.id),
    [visible, columns],
  );
  const autoHiddenKey = autoHidden.join("|");
  // Report only when the set of hidden columns changes.
  useEffect(() => onAutoHiddenChange?.(autoHidden), [autoHiddenKey]);

  const bulk = checked !== undefined && onCheckedChange !== undefined;
  const gridTemplateColumns = (bulk ? "20px " : "") +
    columns.map((c) => (c.columnDef.meta?.width === "fill" ? "minmax(0,1fr)" : `${c.columnDef.meta?.width ?? 80}px`)).join(" ");
  const anchor = useRef<string | null>(null);

  const liveRows = table.getRowModel().rows;
  const [frozenOrder, setFrozenOrder] = useState<string[] | null>(null);
  const rows = useMemo(() => {
    if (!frozenOrder) return liveRows;
    const byId = new Map(liveRows.map((r) => [r.id, r]));
    const known = new Set(frozenOrder);
    return [...frozenOrder.flatMap((id) => byId.get(id) ?? []), ...liveRows.filter((r) => !known.has(r.id))];
  }, [liveRows, frozenOrder]);
  const heldUpdates = frozenOrder ? rows.reduce((n, r, i) => n + (liveRows[i]?.id !== r.id ? 1 : 0), 0) : 0;
  useEffect(() => onHeldUpdatesChange?.(heldUpdates), [heldUpdates]);
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

  // Stable between renders: the virtualizer recomputes every item's position
  // when these change, which must happen per data change, not per scroll frame.
  const estimateSize = useCallback((i: number) => (items[i]?.kind === "group" ? GROUP_HEIGHT : rowHeight), [items, rowHeight]);
  const getItemKey = useCallback(
    (i: number) => {
      const it = items[i];
      return it ? (it.kind === "group" ? `group:${it.key}` : it.row.id) : i;
    },
    [items],
  );
  const virtualizer = useVirtualizer({ count: items.length, getScrollElement: () => scrollRef.current, estimateSize, overscan: OVERSCAN, getItemKey });
  useLayoutEffect(() => virtualizer.measure(), [rowHeight, grouping !== undefined, virtualizer]);

  const selectedItem = useMemo(
    () => (selectedId === null ? -1 : items.findIndex((it) => it.kind === "row" && it.row.id === selectedId)),
    [items, selectedId],
  );
  const selectedPos = useMemo(() => rowPositions.indexOf(selectedItem), [rowPositions, selectedItem]);

  const moveTo = (pos: number) => {
    const p = Math.max(0, Math.min(rowPositions.length - 1, pos));
    const itemIndex = rowPositions[p];
    const it = itemIndex === undefined ? undefined : items[itemIndex];
    if (!it || it.kind !== "row") return;
    onSelect(it.row.id);
    virtualizer.scrollToIndex(itemIndex!, { align: "auto" });
  };

  const rowIds = () => rowPositions.map((i) => (items[i] as { row: Row<T> }).row.id);
  // Row callbacks through a ref: rows stay memoized while these change identity every render.
  const live = useRef({ onSelect, onOpen, toggleChecked: (_: string) => {}, checkRange: (_: string) => {} });
  const toggleChecked = (id: string) => {
    if (!bulk) return;
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    anchor.current = id;
    onCheckedChange(next);
  };
  const checkRange = (to: string) => {
    if (!bulk) return;
    const ids = rowIds();
    const a = ids.indexOf(anchor.current ?? to);
    const b = ids.indexOf(to);
    const [from, until] = a < b ? [a, b] : [b, a];
    onCheckedChange(new Set([...checked, ...ids.slice(Math.max(0, from), until + 1)]));
  };
  live.current = { onSelect, onOpen, toggleChecked, checkRange };
  const handlers = useMemo<RowHandlers>(
    () => ({
      click: (id, e) => {
        if (e.shiftKey) live.current.checkRange(id);
        else if (e.metaKey || e.ctrlKey) live.current.toggleChecked(id);
        live.current.onSelect(id);
      },
      doubleClick: (id) => live.current.onOpen?.(id),
      toggle: (id) => live.current.toggleChecked(id),
    }),
    [],
  );

  /** Opens the row menu for the selected row from the keyboard (⇧F10 / Menu key). */
  const openRowMenu = () => {
    const el = selectedItem >= 0 ? scrollRef.current?.querySelector<HTMLElement>(`#${rowDomId(selectedItem)}`) : null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 160, clientY: r.bottom }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? rowHeight) / rowHeight) - 1);
    const mod = e.metaKey || e.ctrlKey;
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      openRowMenu();
      e.preventDefault();
      return;
    }
    if (bulk && mod && e.key.toLowerCase() === "a") {
      onCheckedChange(new Set(rowIds()));
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case "ArrowDown":
      case "j":
        moveTo(selectedPos + 1);
        break;
      case "ArrowUp":
      case "k":
        moveTo(selectedPos <= 0 ? 0 : selectedPos - 1);
        break;
      case " ":
        if (!bulk || !selectedId) return;
        toggleChecked(selectedId);
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
      default: {
        // Action shortcuts shown in the row menus (L, ⇧R, ⌘⌫, …) act on the selected row.
        const action =
          selectedId && rowActions
            ? rowActions(selectedId)?.actions.find((a) => a.shortcut && !a.disabled && matchesShortcut(e, a.shortcut))
            : undefined;
        if (!action?.onSelect) return;
        action.onSelect();
      }
    }
    e.preventDefault();
  };

  // Keep the selected row in view when the selection changes from outside (palette, links).
  useEffect(() => {
    if (selectedItem >= 0) virtualizer.scrollToIndex(selectedItem, { align: "auto" });
  }, [selectedId]);

  const virtualItems = virtualizer.getVirtualItems();
  const activeRendered = virtualItems.some((v) => v.index === selectedItem);

  return (
    <div ref={rootRef} role="grid" aria-label={ariaLabel} aria-rowcount={items.length + 1} className="flex min-h-0 flex-1 flex-col">
      <div
        role="row"
        className="grid h-[30px] shrink-0 items-center border-b border-line bg-surface-panel text-meta font-medium text-fg-muted dark:bg-transparent"
        style={{ gridTemplateColumns, columnGap, paddingInline: paddingX }}
      >
        {bulk && (
          <div role="columnheader" className="flex items-center">
            <Checkbox
              aria-label={t("Select all rows")}
              checked={checked.size === 0 ? false : checked.size >= rowPositions.length ? true : "indeterminate"}
              onCheckedChange={(on) => onCheckedChange(on ? new Set(rowIds()) : new Set())}
            />
          </div>
        )}
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
            onPointerEnter={() => holdOrderWhileHovered && setFrozenOrder(liveRows.map((r) => r.id))}
            onPointerLeave={() => setFrozenOrder(null)}
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
                          {grouping!.renderLeading?.(
                            it.key,
                            it.rows.map((r) => r.original),
                          )}
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
                  return (
                    <TableRow
                      key={v.key}
                      row={it.row}
                      index={v.index}
                      start={v.start}
                      height={rowHeight}
                      selected={it.row.id === selectedId}
                      checked={bulk && checked.has(it.row.id)}
                      bulk={bulk}
                      columns={columns}
                      gridTemplateColumns={gridTemplateColumns}
                      columnGap={columnGap}
                      paddingX={paddingX}
                      extraClass={rowClassName?.(it.row.original)}
                      handlers={handlers}
                    />
                  );
                })}
              </div>
            )}
            {rows.length === 0 && grouping && empty}
            {after}
          </div>
        </ContextMenuTrigger>
        {menu && <ResourceContextMenuContent actions={menu.actions} target={menu.target} />}
      </ContextMenu>
    </div>
  );
}

interface RowHandlers {
  click: (id: string, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => void;
  doubleClick: (id: string) => void;
  toggle: (id: string) => void;
}

interface TableRowProps<T> {
  row: Row<T>;
  index: number;
  start: number;
  height: number;
  selected: boolean;
  checked: boolean;
  bulk: boolean;
  columns: Column<T, unknown>[];
  gridTemplateColumns: string;
  columnGap: number;
  paddingX: number;
  extraClass?: string;
  handlers: RowHandlers;
}

/**
 * One row. Memoized: while scrolling, rows that stay in view keep their props
 * (same row object, same offset) and are not rendered again; a watch update
 * re-renders only rows whose data changed.
 */
const TableRow = memo(function TableRow<T>({ row, index, start, height, selected, checked, bulk, columns, gridTemplateColumns, columnGap, paddingX, extraClass, handlers }: TableRowProps<T>) {
  return (
    <div
      id={rowDomId(index)}
      data-row-id={row.id}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      onClick={(e) => handlers.click(row.id, e)}
      onDoubleClick={() => handlers.doubleClick(row.id)}
      className={cn(
        // contain: rows have a fixed size, so layout and paint stay inside each row.
        "absolute left-0 top-0 grid w-full items-center border-b border-line-row text-cell text-fg-secondary [contain:strict]",
        selected
          ? "bg-surface-selected text-fg shadow-[inset_0_0_0_1px_var(--line-selected)]"
          : checked
            ? "bg-accent-soft"
            : "bg-surface-panel hover:bg-surface-hover dark:bg-transparent dark:hover:bg-surface-hover",
        extraClass,
      )}
      style={{ gridTemplateColumns, columnGap, paddingInline: paddingX, height, transform: `translateY(${start}px)` }}
    >
      {bulk && (
        <div role="gridcell" className="flex items-center" onClick={(e) => e.stopPropagation()}>
          <Checkbox aria-label={t("Select {id}", { id: row.id })} checked={checked} onCheckedChange={() => handlers.toggle(row.id)} />
        </div>
      )}
      {columns.map((column) => {
        const cell = row.getAllCells().find((c) => c.column.id === column.id)!;
        return (
          <div key={column.id} role="gridcell" className={cn("min-w-0", column.columnDef.meta?.align === "right" && "text-right font-mono text-ui tabular-nums")}>
            {flexRender(column.columnDef.cell, cell.getContext())}
          </div>
        );
      })}
    </div>
  );
}) as <T>(props: TableRowProps<T>) => ReactNode;

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
function fitColumns<T>(
  columns: Column<T, unknown>[],
  width: number,
  gap: number,
  padX: number,
  fillMin: number,
): Column<T, unknown>[] {
  if (width <= 0) return columns;
  const shown = [...columns];
  const required = (cs: Column<T, unknown>[]) =>
    cs.reduce((sum, c) => {
      const w = c.columnDef.meta?.width ?? 80;
      return sum + (w === "fill" ? fillMin : w);
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
