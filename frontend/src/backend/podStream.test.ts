import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PodRow } from "@/data/types";

// The pods stream client over a fake Wails stream: frames in, rows out.

interface FakeSocket {
  sent: unknown[];
  send: (m: unknown) => void;
  onopen?: () => void;
  onmessage?: (ev: { data: unknown }) => void;
  onclose?: () => void;
}
const sockets: FakeSocket[] = [];
vi.mock("@wailsio/runtime", () => ({
  JSONStream: () => {
    const s: FakeSocket = { sent: [], send: (m) => s.sent.push(m) };
    sockets.push(s);
    return s;
  },
}));

// Listeners run on animation frames: run them when the test says so.
let frames: FrameRequestCallback[] = [];
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
vi.stubGlobal("window", { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) });
const flushFrames = () => {
  for (let i = 0; i < 4 && frames.length; i++) {
    const run = frames;
    frames = [];
    run.forEach((cb) => cb(performance.now()));
  }
};

const row = (name: string, p: Partial<PodRow> = {}) => ({ id: `c1/ns/${name}`, name, namespace: "ns", cluster: "c1", status: "Running", ...p }) as PodRow;

async function fresh() {
  vi.resetModules();
  sockets.length = 0;
  frames = [];
  const { podStream } = await import("./podStream");
  podStream.setClusters(["c1"]);
  const s = sockets[0]!;
  s.onopen!();
  const sub = (s.sent[0] as { sub: string }).sub;
  const frame = (f: Record<string, unknown>) => s.onmessage!({ data: { sub, ...f } });
  return { podStream, s, sub, frame };
}

describe("podStream", () => {
  beforeEach(() => vi.useRealTimers());

  it("subscribes once the stream opens", async () => {
    const { s, sub } = await fresh();
    expect(s.sent).toEqual([{ op: "sub", sub, key: { cluster: "c1", kind: "Pod" } }]);
  });

  it("shows a chunked snapshot only when its last part arrived, then applies deltas", async () => {
    const { podStream, frame } = await fresh();
    const seen: number[] = [];
    podStream.listen(() => seen.push(podStream.rows().length));

    frame({ t: "snap", seq: 1, rows: [row("a"), row("b")] });
    frame({ t: "snap", seq: 2, part: 1, rows: [row("c")] });
    flushFrames();
    expect(podStream.rows()).toEqual([]); // not final yet
    frame({ t: "snap", seq: 3, part: 2, final: true, rows: [] });
    flushFrames();
    expect(podStream.rows().map((r) => r.name)).toEqual(["a", "b", "c"]);

    frame({ t: "delta", seq: 4, up: [row("b", { status: "Failed" }), row("d")], del: ["c1/ns/a"] });
    flushFrames();
    expect(podStream.rows().map((r) => `${r.name}:${r.status}`)).toEqual(["b:Failed", "c:Running", "d:Running"]);
    expect(seen.at(-1)).toBe(3);
  });

  it("asks for a fresh snapshot when a frame is missing, and ignores what follows until it comes", async () => {
    const { podStream, s, sub, frame } = await fresh();
    frame({ t: "snap", seq: 1, final: true, rows: [row("a")] });
    frame({ t: "delta", seq: 3, up: [row("x")] }); // seq 2 is missing
    expect(s.sent.at(-1)).toEqual({ op: "resync", sub });
    expect(podStream.rows().map((r) => r.name)).toEqual(["a"]);
    expect(podStream.metrics.gaps).toBe(1);

    frame({ t: "snap", seq: 4, final: true, rows: [row("y")] }); // the resync's snapshot (part 0) is always accepted
    flushFrames();
    expect(podStream.rows().map((r) => r.name)).toEqual(["y"]);
  });

  it("acknowledges what it painted, and stops listening to a removed cluster", async () => {
    const { podStream, s, sub, frame } = await fresh();
    frame({ t: "snap", seq: 1, final: true, rows: [row("a")], tok: 7 });
    flushFrames();
    expect(s.sent).toContainEqual(expect.objectContaining({ op: "ack", tok: 7 }));

    podStream.setClusters([]);
    expect(s.sent.at(-1)).toEqual({ op: "unsub", sub });
    expect(podStream.rows()).toEqual([]);
    frame({ t: "delta", seq: 2, up: [row("late")] }); // in flight when unsubscribed
    expect(podStream.rows()).toEqual([]);
  });

  it("reports state changes per cluster", async () => {
    const { podStream, frame } = await fresh();
    const states: string[] = [];
    podStream.onState((cluster, state, detail) => states.push(`${cluster}:${state}:${detail}`));
    frame({ t: "state", seq: 1, state: "stale", detail: "watch restarting" });
    frame({ t: "state", seq: 2, state: "stale", detail: "watch restarting" }); // unchanged: not repeated
    frame({ t: "state", seq: 3, state: "live" });
    expect(states).toEqual(["c1:stale:watch restarting", "c1:live:"]);
  });
});
