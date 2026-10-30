import { createRow, memo, type Row, type RowData, type RowModel, type Table } from "@tanstack/react-table";

/**
 * TanStack's core row model, but rows whose data object did not change keep
 * their Row object. getCoreRowModel() builds a new Row for every item whenever
 * the data array changes; for a watched list of 10,000+ items that rebuild
 * (and the garbage it leaves) ran on every update batch. With this, a batch
 * that changed 20 pods creates 20 rows, and memoized table rows whose Row
 * object is unchanged do not render again.
 *
 * Flat data only (no getSubRows), and items must be objects.
 */
export function cachedCoreRowModel<T extends RowData>(): (table: Table<T>) => () => RowModel<T> {
  return (table) => {
    // Keyed by the data object, so nothing needs sweeping: rows of replaced or
    // deleted items go with their data. A fresh 50,000-entry Map (and
    // rowsById object) per batch was most of the garbage the table made under
    // a watch storm.
    const rowOf = new WeakMap<object, Row<T>>();
    return memo(
      () => [table.options.data],
      (data) => {
        const rows: Row<T>[] = new Array(data.length);
        for (let i = 0; i < data.length; i++) {
          const original = data[i]!;
          let row = rowOf.get(original as object);
          if (!row) rowOf.set(original as object, (row = createRow(table, table._getRowId(original, i), original, i, 0)));
          else if (row.index !== i) row.index = i; // position only; cached values depend on the data
          rows[i] = row;
        }
        let byId: Record<string, Row<T>> | undefined;
        return {
          rows,
          flatRows: rows,
          // Only selection and getRow() read this; build it on first use.
          get rowsById() {
            return (byId ??= Object.fromEntries(rows.map((r) => [r.id, r])));
          },
        };
      },
      { key: "cachedCoreRowModel", debug: () => false, onChange: () => table._autoResetPageIndex() },
    );
  };
}
