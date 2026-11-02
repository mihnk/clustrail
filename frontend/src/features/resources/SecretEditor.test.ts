import { describe, expect, it } from "vitest";
import { editPlan, editProblems, type EditRow } from "./SecretEditor";

const target = { cluster: "c", namespace: "n", name: "s" };

describe("secret edit plan", () => {
  it("sends only what changed", () => {
    const rows: EditRow[] = [
      { key: "untouched", bytes: 3 },
      { key: "opened", original: "a", value: "a" },
      { key: "changed", original: "a", value: "b" },
      { key: "gone", bytes: 4, removed: true },
      { key: "new", added: true, value: "x" },
      { key: "new-then-removed", added: true, removed: true, value: "y" },
      { key: "bin", added: true, value: "AAE=", binary: true },
    ];
    expect(editPlan(rows, "7", target)).toEqual({
      ...target, resourceVersion: "7",
      set: { changed: { value: "b" }, new: { value: "x" }, bin: { value: "AAE=", binary: true } },
      remove: ["gone"],
    });
  });

  it("finds bad keys, duplicates and bad base64", () => {
    expect(editProblems([{ key: "ok.key-1_A" }])).toEqual([]);
    expect(editProblems([{ key: "bad key", added: true }])).toHaveLength(1);
    expect(editProblems([{ key: "a" }, { key: "a", added: true }])).toHaveLength(1);
    expect(editProblems([{ key: "a", value: "%%%", binary: true }])).toHaveLength(1);
    expect(editProblems([{ key: "bad key", removed: true }])).toEqual([]);
  });
});
