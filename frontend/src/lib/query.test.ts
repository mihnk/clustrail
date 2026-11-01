import { describe, expect, it, vi } from "vitest";
import { flightCount, isPermanent, Query, shared, withRetries } from "./query";

/** A promise resolved or rejected by hand, cancellable like a Wails call. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const p = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  }) as Promise<T> & { cancel: () => void; cancelled: boolean };
  p.cancelled = false;
  p.cancel = () => {
    p.cancelled = true;
    reject(Object.assign(new Error("cancelled"), { name: "CancelError" }));
  };
  return { p, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const noSleep = () => Promise.resolve();

/** A fake poll scheduler: fire() runs the poll by hand. */
function fakeSchedule() {
  let run: (() => void) | null = null;
  return {
    schedule: (fn: () => void) => {
      run = fn;
      return () => {
        run = null;
      };
    },
    fire: () => run?.(),
    active: () => run !== null,
  };
}

describe("Query", () => {
  it("drops the answer for a key the view left: a quick switch never shows the older cluster", async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const q = new Query<string>({ retries: 0 });
    q.setKey("ns|cluster-a", () => a.p);
    q.setKey("ns|cluster-b", () => b.p);
    b.resolve("b");
    await tick();
    a.resolve("a"); // the slow, older answer arrives last
    await tick();
    expect(q.getSnapshot()).toMatchObject({ key: "ns|cluster-b", data: "b", loading: false, error: null });
    expect(a.p.cancelled).toBe(true); // nobody waited for it any more
  });

  it("an older poll for the same key never replaces a newer answer", async () => {
    const s = fakeSchedule();
    const calls: ReturnType<typeof deferred<number>>[] = [];
    const q = new Query<number>({ retries: 0, every: 1000, schedule: s.schedule });
    q.setKey("job|x", () => {
      const d = deferred<number>();
      calls.push(d);
      return d.p;
    });
    s.fire(); // the first request is still in flight: no second one
    expect(calls).toHaveLength(1);
    q.refresh(); // a refresh replaces it
    expect(calls).toHaveLength(2);
    calls[1]!.resolve(2);
    await tick();
    calls[0]!.resolve(1);
    await tick();
    expect(q.getSnapshot().data).toBe(2);
  });

  it("a rejected request never leaves loading behind, and keeps the last data as stale", async () => {
    const s = fakeSchedule();
    let n = 0;
    const q = new Query<string>({ retries: 0, every: 1000, schedule: s.schedule });
    q.setKey("events|x", () => (++n === 1 ? Promise.resolve("first") : Promise.reject(new Error("connection refused"))));
    await tick();
    expect(q.getSnapshot()).toMatchObject({ data: "first", stale: false, loading: false });
    s.fire();
    expect(q.getSnapshot().loading).toBe(true);
    await tick();
    expect(q.getSnapshot()).toMatchObject({ data: "first", stale: true, loading: false, error: "connection refused" });
  });

  it("stopping (unmount, view hidden) cancels the request and clears loading", async () => {
    const d = deferred<string>();
    const q = new Query<string>({ retries: 0 });
    q.setKey("detail|p", () => d.p);
    expect(q.getSnapshot().loading).toBe(true);
    q.stop();
    expect(q.getSnapshot().loading).toBe(false);
    expect(d.p.cancelled).toBe(true);
    await tick();
    expect(q.getSnapshot().error).toBeNull(); // the cancellation is not shown as an error
  });

  it("keeps the previous key's data, marked stale, only when asked", async () => {
    const q = new Query<string>({ retries: 0, keepPrevious: true });
    q.setKey("k1", () => Promise.resolve("one"));
    await tick();
    const d = deferred<string>();
    q.setKey("k2", () => d.p);
    expect(q.getSnapshot()).toMatchObject({ key: "k2", data: "one", stale: true, loading: true });
    d.resolve("two");
    await tick();
    expect(q.getSnapshot()).toMatchObject({ data: "two", stale: false });

    const plain = new Query<string>({ retries: 0 });
    plain.setKey("k1", () => Promise.resolve("one"));
    await tick();
    plain.setKey("k2", () => new Promise(() => {}));
    expect(plain.getSnapshot().data).toBeUndefined();
    plain.stop();
    expect(flightCount()).toBe(0); // stopping released the request that never came back
  });

  it("the same key again neither reloads nor drops its data", async () => {
    const fetch = vi.fn(() => Promise.resolve("x"));
    const s = fakeSchedule();
    const q = new Query<string>({ retries: 0, every: 1000, schedule: s.schedule });
    q.setKey("k", fetch);
    await tick();
    q.setKey("k", fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(q.getSnapshot().data).toBe("x");
  });

  it("waits out delay so rapid selection changes load once", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((k: string) => Promise.resolve(k));
      const q = new Query<string>({ retries: 0, delay: 120 });
      for (const k of ["p1", "p2", "p3"]) q.setKey(k, () => fetch(k));
      await vi.advanceTimersByTimeAsync(200);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith("p3");
      expect(q.getSnapshot().data).toBe("p3");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("shared (single flight)", () => {
  it("two views asking the same key make one request", async () => {
    const fetch = vi.fn(() => Promise.resolve(42));
    const a = new Query<number>({ retries: 0 });
    const b = new Query<number>({ retries: 0 });
    a.setKey("podDetail|c/ns/p", fetch);
    b.setKey("podDetail|c/ns/p", fetch);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a.getSnapshot().data).toBe(42);
    expect(b.getSnapshot().data).toBe(42);
    expect(flightCount()).toBe(0);
  });

  it("the request is cancelled only when the last caller leaves", () => {
    const d = deferred<number>();
    const one = shared("k", () => d.p);
    const two = shared("k", () => d.p);
    one.release();
    expect(d.p.cancelled).toBe(false);
    two.release();
    expect(d.p.cancelled).toBe(true);
    expect(flightCount()).toBe(0);
  });

  it("fresh starts a new request; the old one's callers keep theirs", async () => {
    const first = deferred<number>();
    const old = shared("k", () => first.p);
    const next = shared("k", () => Promise.resolve(2), true);
    expect(await next.promise).toBe(2);
    first.resolve(1);
    expect(await old.promise).toBe(1);
    old.release();
    next.release();
  });
});

describe("withRetries", () => {
  it("retries a transient error, a bounded number of times", async () => {
    let n = 0;
    const fails = () => (++n, Promise.reject(new Error("dial tcp: i/o timeout")));
    await expect(withRetries(fails, 2, noSleep)).rejects.toThrow("i/o timeout");
    expect(n).toBe(3);
    let m = 0;
    expect(await withRetries(() => (++m < 2 ? Promise.reject(new Error("EOF")) : Promise.resolve("ok")), 2, noSleep)).toBe("ok");
  });

  it("never retries what a retry cannot fix", async () => {
    let n = 0;
    await expect(withRetries(() => (++n, Promise.reject(new Error('pods "x" is forbidden: User cannot get'))), 5, noSleep)).rejects.toThrow();
    expect(n).toBe(1);
    expect(isPermanent(new Error('deployments.apps "api" not found'))).toBe(true);
    expect(isPermanent(Object.assign(new Error("x"), { name: "CancelError" }))).toBe(true);
    expect(isPermanent(new Error("connection reset by peer"))).toBe(false);
  });

  it("cancel stops the attempt in flight and every later one", async () => {
    const d = deferred<string>();
    let n = 0;
    const p = withRetries(() => (++n, d.p), 3, noSleep);
    p.cancel?.();
    await expect(p).rejects.toThrow();
    expect(d.p.cancelled).toBe(true);
    expect(n).toBe(1);
  });
});
