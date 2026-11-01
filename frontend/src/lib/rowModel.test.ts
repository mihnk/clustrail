import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createTable, type ColumnDef, type TableOptionsResolved } from "@tanstack/react-table";
import { cachedCoreRowModel } from "./rowModel";

interface Item {
  id: string;
  n: number;
}

const columns: ColumnDef<Item>[] = [
  { id: "n", accessorFn: (r) => r.n },
  { id: "none", accessorFn: () => undefined },
];

function table(data: Item[]) {
  const options: TableOptionsResolved<Item> = {
    data,
    columns,
    getCoreRowModel: cachedCoreRowModel(),
    getRowId: (r) => r.id,
    state: {},
    onStateChange: () => {},
    renderFallbackValue: null,
  };
  const t = createTable(options);
  t.setOptions((prev) => ({ ...prev, state: t.initialState }));
  // Columns keep the options of the render that built them (TanStack, once per
  // column set): build them now, before any data, so only rows are measured.
  t.getAllLeafColumns();
  return t;
}

const setData = (t: ReturnType<typeof table>, data: Item[]) => t.setOptions((prev) => ({ ...prev, data }));

describe("cachedCoreRowModel", () => {
  it("keeps the Row of an unchanged item and makes one for a changed or new item", () => {
    const a = { id: "a", n: 1 };
    const b = { id: "b", n: 2 };
    const t = table([a, b]);
    const [ra, rb] = t.getCoreRowModel().rows;

    const b2 = { ...b, n: 3 };
    const c = { id: "c", n: 4 };
    setData(t, [c, a, b2]);
    const rows = t.getCoreRowModel().rows;
    expect(rows[1]).toBe(ra);
    expect(rows[1]!.index).toBe(1); // moved: index follows
    expect(rows[2]).not.toBe(rb);
    expect(rows[2]!.getValue("n")).toBe(3);
    expect(rows.map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(t.getCoreRowModel().rowsById.a).toBe(ra);
  });

  it("rows read the table's current options, not the ones they were made with", () => {
    const t = table([{ id: "a", n: 1 }]);
    const row = t.getCoreRowModel().rows[0]!;
    t.setOptions((prev) => ({ ...prev, renderFallbackValue: "–" }));
    expect(row.renderValue("none")).toBe("–");
  });

  // A kept row held the options of the render that made it, and with them that
  // render's data array: under a watch storm one more array per update, never freed.
  it("a kept row does not keep the data array it was made from", async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const kept = { id: "kept", n: 1 };
    const t = table([]);
    // In its own function, so no variable of this test holds the array.
    const render = (): WeakRef<Item[]> => {
      const first = [kept, ...Array.from({ length: 1000 }, (_, i) => ({ id: `x${i}`, n: i }))];
      setData(t, first); // the row of `kept` is made in this render
      t.getCoreRowModel().rows.forEach((r) => r.getAllCells()); // cells capture the options too
      return new WeakRef(first);
    };
    const ref = render();
    setData(t, [kept]); // the row of `kept` lives on
    t.getCoreRowModel().rows.forEach((r) => r.getAllCells());
    await new Promise((r) => setTimeout(r, 0));
    gc();
    expect(ref.deref()).toBeUndefined();
  });
});
