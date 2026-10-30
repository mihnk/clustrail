// Pods arrive on a Wails stream as numbered frames: a snapshot (in chunks),
// then deltas. Frames are applied to per-subscription maps as they arrive;
// listeners are told at most once per animation frame, so a burst renders once.
import { JSONStream } from "@wailsio/runtime";
import type { PodRow } from "@/data/types";

export type StreamState = "connecting" | "live" | "stale" | "disconnected" | "error";

interface Frame {
  t: "snap" | "delta" | "state" | "error";
  sub: string;
  seq: number;
  part?: number;
  final?: boolean;
  rows?: PodRow[];
  up?: PodRow[];
  del?: string[];
  state?: StreamState;
  detail?: string;
  ev?: number;
  tok?: number;
}

interface Sub {
  id: string;
  cluster: string;
  seq: number;
  rows: Map<string, PodRow>;
  staging: Map<string, PodRow> | null;
  state: StreamState;
  detail: string;
  snapshotAt: number | null; // when the first full snapshot completed (ms since subscribe)
  subscribedAt: number;
}

/** Frontend-side numbers for the diagnostics view and benchmarks. */
export interface StreamMetrics {
  frames: number;
  gaps: number;
  applyMs: number[]; // per frame: parse is done by the transport; this is map updates
  renderMs: number[]; // frame received → painted (two animation frames after commit)
  paintMs: number[]; // listeners notified → painted: what one UI update costs
}

const MAX_SAMPLES = 2048;
const push = (a: number[], v: number) => {
  a.push(v);
  if (a.length > MAX_SAMPLES) a.splice(0, a.length - MAX_SAMPLES);
};

class PodStream {
  private socket: ReturnType<typeof JSONStream> | null = null;
  private open = false;
  private outbox: unknown[] = [];
  private subs = new Map<string, Sub>();
  private byCluster = new Map<string, string>();
  private listeners = new Set<() => void>();
  private stateListeners = new Set<(cluster: string, state: StreamState, detail: string) => void>();
  private version = 0;
  private cached: { version: number; rows: PodRow[] } = { version: -1, rows: [] };
  private frame = 0;
  private pendingAcks: { tok: number; at: number }[] = [];
  private nextSub = 0;
  readonly metrics: StreamMetrics = { frames: 0, gaps: 0, applyMs: [], renderMs: [], paintMs: [] };

  private connect() {
    if (this.socket) return;
    const s = JSONStream("clustrail.pods");
    s.onopen = () => {
      this.open = true;
      for (const m of this.outbox) s.send(m);
      this.outbox = [];
    };
    s.onmessage = (ev: MessageEvent<Frame>) => this.onFrame(ev.data);
    s.onclose = () => {
      // The page lives on (e.g. after a backend restart in development): reconnect and resubscribe.
      this.socket = null;
      this.open = false;
      const clusters = [...this.byCluster.keys()];
      this.subs.clear();
      this.byCluster.clear();
      setTimeout(() => this.setClusters(clusters), 500);
    };
    this.socket = s;
  }

  private send(m: unknown) {
    this.connect();
    if (this.open) this.socket!.send(m);
    else this.outbox.push(m);
  }

  /** Keeps exactly one subscription per listed cluster (all namespaces). */
  setClusters(clusters: string[]) {
    const want = new Set(clusters);
    for (const [cluster, id] of this.byCluster) {
      if (want.has(cluster)) continue;
      this.send({ op: "unsub", sub: id });
      this.subs.delete(id);
      this.byCluster.delete(cluster);
      this.changed();
    }
    for (const cluster of want) {
      if (this.byCluster.has(cluster)) continue;
      const id = `p${++this.nextSub}`;
      this.subs.set(id, { id, cluster, seq: 0, rows: new Map(), staging: null, state: "connecting", detail: "", snapshotAt: null, subscribedAt: performance.now() });
      this.byCluster.set(cluster, id);
      this.send({ op: "sub", sub: id, key: { cluster, kind: "Pod" } });
    }
  }

  private onFrame(f: Frame) {
    const sub = this.subs.get(f.sub);
    if (!sub) return; // unsubscribed meanwhile
    const at = performance.now();
    this.metrics.frames++;
    if (f.t === "snap" && (f.part ?? 0) === 0) {
      // part is omitted when 0 (Go omitempty)
      sub.staging = new Map();
    } else if (f.seq !== sub.seq + 1) {
      // A frame is missing: the rows can no longer be trusted. Ask for a fresh snapshot.
      this.metrics.gaps++;
      sub.seq = f.seq;
      this.send({ op: "resync", sub: sub.id });
      return;
    }
    sub.seq = f.seq;
    switch (f.t) {
      case "snap":
        if (!sub.staging) return;
        for (const r of f.rows ?? []) sub.staging.set(r.id, r);
        if (f.final) {
          sub.rows = sub.staging;
          sub.staging = null;
          if (sub.snapshotAt === null) sub.snapshotAt = at - sub.subscribedAt;
        }
        break;
      case "delta":
        for (const r of f.up ?? []) sub.rows.set(r.id, r);
        for (const id of f.del ?? []) sub.rows.delete(id);
        break;
      case "error":
        sub.rows = new Map();
        break;
    }
    if (f.state && (f.state !== sub.state || (f.detail ?? "") !== sub.detail)) {
      sub.state = f.state;
      sub.detail = f.detail ?? "";
      for (const l of this.stateListeners) l(sub.cluster, sub.state, sub.detail);
    }
    push(this.metrics.applyMs, performance.now() - at);
    if (f.tok) this.pendingAcks.push({ tok: f.tok, at });
    if (f.t !== "snap" || f.final) this.changed();
  }

  // Adaptive pacing: the next render waits at least as long as the last one
  // cost, so under a storm the UI spends at most about half its time rendering
  // updates and stays responsive to input; quiet streams render next frame.
  private renderCost = 0;
  private lastRender = 0;
  private timer = 0;

  private changed() {
    this.version++;
    if (this.frame || this.timer) return;
    const wait = Math.max(0, this.lastRender + this.renderCost - performance.now());
    const run = () => {
      this.timer = 0;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        const start = performance.now();
        const acks = this.pendingAcks;
        this.pendingAcks = [];
        for (const l of this.listeners) l();
        // The next frame starts after React committed and the browser painted this one.
        requestAnimationFrame(() => {
          const now = performance.now();
          this.lastRender = now;
          this.renderCost = Math.min(1000, now - start);
          push(this.metrics.paintMs, now - start);
          for (const a of acks) {
            const ui = now - a.at;
            push(this.metrics.renderMs, ui);
            this.send({ op: "ack", tok: a.tok, ui });
          }
        });
      });
    };
    if (wait > 0) this.timer = window.setTimeout(run, wait);
    else run();
  }

  /** All rows of all subscriptions; rebuilt once per change, not per read. */
  rows(): PodRow[] {
    if (this.cached.version !== this.version) {
      const out: PodRow[] = [];
      for (const s of this.subs.values()) for (const r of s.rows.values()) out.push(r);
      this.cached = { version: this.version, rows: out };
    }
    return this.cached.rows;
  }

  states(): { cluster: string; state: StreamState; detail: string; rows: number; snapshotMs: number | null }[] {
    return [...this.subs.values()].map((s) => ({ cluster: s.cluster, state: s.state, detail: s.detail, rows: s.rows.size, snapshotMs: s.snapshotAt }));
  }

  listen(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onState(fn: (cluster: string, state: StreamState, detail: string) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }
}

export const podStream = new PodStream();
