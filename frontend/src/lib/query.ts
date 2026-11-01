// One way to load data for a view (issue E5):
// - the latest result wins: a response for an older key, or an older request
//   for the same key, is dropped;
// - requests are cancelled when nobody waits for them any more (unmount, key
//   change), and identical requests in flight are made once (single flight);
// - an error keeps the last data, so the view shows stale data and the error;
// - retries are bounded, polls never overlap, so a slow cluster cannot turn
//   into a storm of requests.
// Query is plain TypeScript (tested in lib/query.test.ts); useQuery and
// useQueries in lib/useQuery.ts bind it to React.
import { everyWhileVisible } from "./everyWhileVisible";

export interface QueryOptions {
  /** Poll every this many ms while the window is visible (0: load once per key). */
  every?: number;
  /** Retries after a failure, with backoff; default 2. Permanent errors are not retried. */
  retries?: number;
  /** Wait this long after a key change before loading (rapid selection changes load once). */
  delay?: number;
  /** Keep showing the previous key's data, marked stale, until the new key's arrives. */
  keepPrevious?: boolean;
  /** Timers, for tests: defaults to everyWhileVisible and setTimeout. */
  schedule?: (run: () => void, ms: number) => () => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface QueryState<T> {
  /** The key the state is for (null: disabled). */
  key: string | null;
  /** The latest data for key, or the previous key's with keepPrevious. */
  data: T | undefined;
  /** The data is not the answer to the latest request: from another key, or the latest request failed. */
  stale: boolean;
  /** The latest request's error, as text. */
  error: string | null;
  /** A request for key is in flight. */
  loading: boolean;
  /** When data arrived (ms since epoch), 0 when there is none. */
  updatedAt: number;
}

type Cancellable<T> = Promise<T> & { cancel?: (cause?: unknown) => unknown };

interface Flight {
  promise: Promise<unknown>;
  users: number;
  settled: boolean;
  cancel: () => void;
}

const flights = new Map<string, Flight>();

/**
 * Joins the request in flight for key, or starts one. release() says the
 * caller no longer waits; the last one to leave cancels a request that has
 * not settled. fresh starts a new request even if one is in flight (a
 * refresh after a change); callers of the old one keep theirs.
 */
export function shared<T>(key: string, start: () => Promise<T>, fresh = false): { promise: Promise<T>; release: () => void } {
  let f = fresh ? undefined : flights.get(key);
  if (!f) {
    const p = start() as Cancellable<T>;
    const flight: Flight = {
      promise: p,
      users: 0,
      settled: false,
      cancel: () => {
        try {
          void Promise.resolve(p.cancel?.("no longer needed")).catch(() => {});
        } catch {
          // a promise that cannot be cancelled is left to settle
        }
      },
    };
    const done = () => {
      flight.settled = true;
      if (flights.get(key) === flight) flights.delete(key);
    };
    p.then(done, done);
    flights.set(key, flight);
    f = flight;
  }
  const flight = f;
  flight.users++;
  let released = false;
  return {
    promise: flight.promise as Promise<T>,
    release: () => {
      if (released) return;
      released = true;
      flight.users--;
      if (flight.users === 0 && !flight.settled) {
        if (flights.get(key) === flight) flights.delete(key);
        flight.cancel();
      }
    },
  };
}

/** Requests in flight, for tests. */
export function flightCount(): number {
  return flights.size;
}

const PERMANENT = /forbidden|not ?found|unauthori[sz]ed|invalid|refused by|read-only|too large|no longer needed|cancel/i;

/** Errors a retry cannot fix: RBAC, missing objects, bad input, cancellation. */
export function isPermanent(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "CancelError" || name === "AbortError") return true;
  return PERMANENT.test(errorMessage(err));
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    try {
      const parsed = JSON.parse(e.message) as { message?: string };
      if (parsed.message) return parsed.message;
    } catch {
      // plain text
    }
    return e.message;
  }
  return typeof e === "string" ? e : String(e);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs start, retrying up to retries times with backoff (500 ms, 1.5 s, …,
 * with jitter) unless the error is permanent. cancel() on the result cancels
 * the attempt in flight (a Wails call cancels its Go context) and stops
 * further attempts.
 */
export function withRetries<T>(start: () => Promise<T>, retries: number, sleep = defaultSleep): Cancellable<T> {
  let current: Cancellable<T> | null = null;
  let cancelled = false;
  const run = async (): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      if (cancelled) throw new CancelledError();
      current = start() as Cancellable<T>;
      try {
        return await current;
      } catch (e) {
        if (cancelled || attempt >= retries || isPermanent(e)) throw e;
      }
      await sleep(500 * 3 ** attempt * (0.75 + Math.random() * 0.5));
    }
  };
  const p = run() as Cancellable<T>;
  p.cancel = () => {
    cancelled = true;
    return current?.cancel?.("no longer needed");
  };
  return p;
}

class CancelledError extends Error {
  override name = "CancelError";
  constructor() {
    super("no longer needed");
  }
}

const IDLE: QueryState<never> = { key: null, data: undefined, stale: false, error: null, loading: false, updatedAt: 0 };

/** One view's data for one key at a time. */
export class Query<T> {
  private state: QueryState<T> = IDLE;
  private listeners = new Set<() => void>();
  private fetcher: (() => Promise<T>) | null = null;
  private seq = 0;
  private release: (() => void) | null = null;
  private stopPoll: (() => void) | null = null;
  private delayTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly opts: QueryOptions;

  constructor(opts: QueryOptions = {}) {
    this.opts = opts;
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getSnapshot = () => this.state;

  /** Follows key (null: idle). The same key keeps its data and does not reload. */
  setKey(key: string | null, fetcher: () => Promise<T>) {
    this.fetcher = fetcher;
    if (key === this.state.key && (this.release || this.stopPoll || this.delayTimer !== undefined)) return;
    this.stop();
    const sameKey = key === this.state.key;
    if (key === null) {
      this.set({ ...IDLE });
      return;
    }
    const keep = sameKey || this.opts.keepPrevious;
    this.set({
      key,
      data: keep ? this.state.data : undefined,
      stale: keep && !sameKey ? this.state.data !== undefined : this.state.stale,
      error: sameKey ? this.state.error : null,
      loading: true,
      updatedAt: keep ? this.state.updatedAt : 0,
    });
    const begin = () => {
      this.delayTimer = undefined;
      this.run(false);
      const every = this.opts.every ?? 0;
      if (every > 0) this.stopPoll = (this.opts.schedule ?? everyWhileVisible)(() => this.poll(), every);
    };
    if (this.opts.delay) this.delayTimer = setTimeout(begin, this.opts.delay);
    else begin();
  }

  /** Loads again now, replacing a request in flight (after a change the user made). */
  refresh() {
    if (this.state.key === null || !this.fetcher) return;
    this.run(true);
  }

  /** Stops polling and leaves the request in flight; the state stays as it is. */
  stop() {
    this.seq++;
    this.release?.();
    this.release = null;
    this.stopPoll?.();
    this.stopPoll = null;
    if (this.delayTimer !== undefined) clearTimeout(this.delayTimer);
    this.delayTimer = undefined;
    if (this.state.loading) this.set({ ...this.state, loading: false });
  }

  private poll() {
    if (this.release) return; // the last poll has not come back: never two at once
    this.run(false);
  }

  private run(fresh: boolean) {
    const key = this.state.key;
    const fetcher = this.fetcher;
    if (key === null || !fetcher) return;
    this.release?.();
    const seq = ++this.seq;
    const retries = this.opts.retries ?? 2;
    const flight = shared(key, () => withRetries(fetcher, retries, this.opts.sleep), fresh);
    this.release = flight.release;
    if (!this.state.loading) this.set({ ...this.state, loading: true });
    flight.promise.then(
      (data) => {
        if (seq !== this.seq) return;
        this.release = null;
        this.set({ key, data, stale: false, error: null, loading: false, updatedAt: Date.now() });
      },
      (err: unknown) => {
        if (seq !== this.seq) return;
        this.release = null;
        this.set({ ...this.state, stale: this.state.data !== undefined, error: errorMessage(err), loading: false });
      },
    );
  }

  private set(next: QueryState<T>) {
    this.state = next;
    for (const l of this.listeners) l();
  }
}
