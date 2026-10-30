// Field-level comparison of the same object in several clusters. The backend
// reads each object (matched by kind, namespace and name), reduces it to the
// fields below and the frontend diffs them. Secret values are never read:
// env vars from secrets are compared by reference only.

import { stringify } from "yaml";
import type { DeploymentRow, Health } from "./types";

export interface EnvVar {
  value?: string;
  /** e.g. "secretKeyRef checkout-api-db/password" */
  ref?: string;
}

export interface Snapshot {
  cluster: string;
  ready: string;
  health: Health;
  images: Record<string, string>;
  replicas: number;
  hpa: string | null;
  /** container → field ("requests.memory") → quantity */
  resources: Record<string, Record<string, string>>;
  env: Record<string, Record<string, EnvVar>>;
  /** Referenced ConfigMaps: key count and content hash. */
  configRefs: Record<string, { keys: number; sha: string }>;
  podHealth: string;
  metadata: Record<string, string>;
}

export type DiffKind = "changed" | "only" | "ref" | "status" | "content";

export interface DiffRow {
  kind: DiffKind;
  field: string;
  /** One value per compared cluster; null when the field is absent there. */
  values: (string | null)[];
  /** For "only": the index of the cluster that has the field. */
  onlyIn?: number;
  /** Where "Show in YAML" jumps to. */
  path?: string;
}

export interface DiffSection {
  id: string;
  title: string;
  scope?: string;
  rows: DiffRow[];
  /** Rows hidden by "Differences only". */
  identical: DiffRow[];
  /** Summary shown when every field is identical, or alongside differences. */
  note?: string;
  /** Status sections compare what the cluster reports now, not the spec. */
  status?: boolean;
}

const CHECKOUT_ENV_COMMON: Record<string, EnvVar> = {
  JAVA_TOOL_OPTIONS: { value: "-Xmx384m -XX:+UseG1GC" },
  LOG_LEVEL: { value: "info" },
  OTEL_EXPORTER_OTLP_ENDPOINT: { value: "http://otel-collector.observability:4317" },
  HTTP_PORT: { value: "8080" },
  PRICE_CACHE_TTL: { value: "5m" },
  PAYMENTS_GATEWAY_URL: { value: "http://gateway.payments.svc:8080" },
  REDIS_HOST: { value: "checkout-redis.payments.svc" },
  REDIS_PORT: { value: "6379" },
  DB_HOST: { value: "checkout-db.payments.svc" },
  DB_NAME: { value: "checkout" },
  DB_USER: { ref: "secretKeyRef checkout-api-db/username" },
  DB_PASSWORD: { ref: "secretKeyRef checkout-api-db/password" },
};

/** Snapshot of a Deployment as the backend would reduce it. */
export function snapshotFor(d: DeploymentRow): Snapshot {
  const tag = d.image;
  const base: Snapshot = {
    cluster: d.cluster,
    ready: `${d.readyReplicas}/${d.replicas}`,
    health: d.health,
    images: { app: `ghcr.io/acme/${d.name}:${tag}` },
    replicas: d.replicas,
    hpa: d.hpa ? `min ${d.hpa.min} · max ${d.hpa.max} · CPU 70%` : null,
    resources: { app: { "requests.cpu": "100m", "requests.memory": "128Mi", "limits.memory": "256Mi" } },
    env: { app: { LOG_LEVEL: { value: d.env === "prod" ? "warn" : "info" } } },
    configRefs: {},
    podHealth: `${d.readyReplicas}/${d.replicas} · 0 restarts`,
    metadata: { "deployment.kubernetes.io/revision": String(d.revisions[0]?.rev ?? 1) },
  };
  if (d.name !== "checkout-api") return base;

  const prod = d.env === "prod";
  return {
    ...base,
    images: { api: `ghcr.io/acme/checkout-api:${tag}`, envoy: "envoyproxy/envoy:v1.31.2" },
    resources: {
      api: {
        "requests.cpu": "250m",
        "requests.memory": prod ? "192Mi" : "384Mi",
        "limits.cpu": "1",
        "limits.memory": prod ? "256Mi" : "512Mi",
      },
      envoy: { "requests.cpu": "50m", "requests.memory": "64Mi", "limits.memory": "128Mi" },
    },
    env: {
      api: {
        ...CHECKOUT_ENV_COMMON,
        DB_POOL_SIZE: { value: prod ? "40" : "10" },
        ...(prod ? {} : { FEATURE_NEW_PRICING: { value: '"true"' } }),
      },
    },
    configRefs: { "checkout-api-config": { keys: 12, sha: prod ? "81c27e" : "3f9a1c" } },
    podHealth: prod ? `${d.readyReplicas}/${d.replicas} · 25 restarts · OOMKilled` : `${d.readyReplicas}/${d.replicas} · 0 restarts`,
    metadata: { "deployment.kubernetes.io/revision": prod ? "14" : "9" },
  };
}

function diffMaps(
  maps: (Record<string, string> | undefined)[],
  fieldName: (k: string) => string = (k) => k,
  path?: (k: string) => string,
): { rows: DiffRow[]; identical: DiffRow[] } {
  const keys = [...new Set(maps.flatMap((m) => Object.keys(m ?? {})))];
  const rows: DiffRow[] = [];
  const identical: DiffRow[] = [];
  for (const k of keys) {
    const values = maps.map((m) => m?.[k] ?? null);
    const present = values.filter((v) => v !== null);
    const row: DiffRow = { kind: "changed", field: fieldName(k), values, path: path?.(k) };
    if (present.length < values.length) {
      row.kind = "only";
      if (present.length === 1) row.onlyIn = values.findIndex((v) => v !== null);
      rows.push(row);
    } else if (new Set(values).size > 1) rows.push(row);
    else identical.push(row);
  }
  return { rows, identical };
}

/** Diffs snapshots section by section. The first snapshot is the reference column. */
export function compareSnapshots(snaps: Snapshot[]): DiffSection[] {
  const sections: DiffSection[] = [];

  const images = diffMaps(snaps.map((s) => s.images), undefined, (k) => `containers[${k}].image`);
  sections.push({
    id: "img",
    title: "Images",
    ...images,
    note:
      images.rows.length === 0
        ? `${Object.entries(snaps[0]!.images)
            .map(([c, i]) => `${c} ${i}`)
            .join(" · ")} — identical`
        : undefined,
  });

  const rep = diffMaps(
    snaps.map((s) => ({ "spec.replicas": String(s.replicas), ...(s.hpa ? { HorizontalPodAutoscaler: s.hpa } : {}) })),
    undefined,
    (k) => (k === "spec.replicas" ? "spec.replicas" : "hpa"),
  );
  sections.push({ id: "rep", title: "Replicas & HPA", ...rep });

  // One section per container whose requests or limits differ; identical containers are named in a note.
  const containers = [...new Set(snaps.flatMap((s) => Object.keys(s.resources)))];
  const perContainer = containers.map((c) => ({
    c,
    ...diffMaps(snaps.map((s) => s.resources[c]), undefined, (k) => `containers[${c}].resources.${k}`),
  }));
  const same = perContainer.filter((p) => p.rows.length === 0).map((p) => p.c);
  const differing = perContainer.filter((p) => p.rows.length > 0);
  for (const p of differing)
    sections.push({
      id: `res-${p.c}`,
      title: "Requests & limits",
      scope: `container ${p.c}`,
      rows: p.rows,
      identical: p.identical,
      note: [!p.rows.some((r) => r.field.endsWith(".cpu")) && "cpu identical", ...same.map((o) => `${o} identical`)].filter(Boolean).join(" · ") || undefined,
    });
  if (differing.length === 0)
    sections.push({ id: "res", title: "Requests & limits", rows: [], identical: perContainer.flatMap((p) => p.identical), note: "identical in all containers" });

  for (const c of [...new Set(snaps.flatMap((s) => Object.keys(s.env)))]) {
    const vars = snaps.map((s) => s.env[c]);
    const names = [...new Set(vars.flatMap((v) => Object.keys(v ?? {})))];
    const rows: DiffRow[] = [];
    const identical: DiffRow[] = [];
    for (const n of names) {
      const vs = vars.map((v) => v?.[n]);
      const values = vs.map((v) => (v ? (v.ref ?? v.value ?? "") : null));
      const path = `containers[${c}].env[${n}]`;
      if (vs.some((v) => v?.ref)) {
        // Secret-backed: compare the reference, never the value.
        const row: DiffRow = { kind: new Set(values).size > 1 ? "changed" : "ref", field: n, values, path };
        rows.push(row);
        continue;
      }
      const present = values.filter((v) => v !== null);
      if (present.length < values.length) rows.push({ kind: "only", field: n, values, path, onlyIn: values.findIndex((v) => v !== null) });
      else if (new Set(values).size > 1) rows.push({ kind: "changed", field: n, values, path });
      else identical.push({ kind: "changed", field: n, values, path });
    }
    const changed = rows.filter((r) => r.kind !== "ref");
    const refs = rows.filter((r) => r.kind === "ref");
    const highlight = identical.find((r) => r.field === "JAVA_TOOL_OPTIONS");
    sections.push({
      id: `env-${c}`,
      title: "Environment",
      scope: `container ${c} · ${names.length} variables`,
      rows: [...changed, ...refs],
      identical,
      note: identical.length ? `${identical.length} identical${highlight ? ", incl. JAVA_TOOL_OPTIONS" : ""}` : undefined,
    });
  }

  const cfgNames = [...new Set(snaps.flatMap((s) => Object.keys(s.configRefs)))];
  if (cfgNames.length) {
    const rows: DiffRow[] = [];
    const identical: DiffRow[] = [];
    for (const n of cfgNames) {
      const values = snaps.map((s) => (s.configRefs[n] ? `${s.configRefs[n]!.keys} keys · sha ${s.configRefs[n]!.sha}` : null));
      (new Set(values).size > 1 ? rows : identical).push({ kind: "content", field: `ConfigMap ${n}`, values });
    }
    sections.push({ id: "cfg", title: "Config references", rows, identical });
  }

  sections.push({
    id: "health",
    title: "Pod health",
    scope: "status, not spec — changes over time",
    rows: [{ kind: "status", field: "ready · restarts", values: snaps.map((s) => s.podHealth) }],
    identical: [],
    status: true,
  });

  const meta = diffMaps(snaps.map((s) => s.metadata));
  sections.push({ id: "meta", title: "Metadata", scope: "selected labels & annotations", ...meta });

  return sections;
}

/** The spec as YAML for the line diff (metadata.managedFields and status excluded). */
export function specYaml(s: Snapshot): string {
  return stringify({
    replicas: s.replicas,
    template: {
      spec: {
        containers: Object.keys(s.images).map((c) => ({
          name: c,
          image: s.images[c],
          ...(s.env[c]
            ? {
                env: Object.entries(s.env[c]!).map(([name, v]) => (v.ref ? { name, valueFrom: v.ref } : { name, value: v.value })),
              }
            : {}),
          resources: Object.entries(s.resources[c] ?? {}).reduce<Record<string, Record<string, string>>>((acc, [k, v]) => {
            const [group, res] = k.split(".") as [string, string];
            (acc[group] ??= {})[res] = v;
            return acc;
          }, {}),
        })),
      },
    },
  });
}

export interface DiffLine {
  op: " " | "+" | "-";
  text: string;
  /** Line numbers in the left and right document. */
  a?: number;
  b?: number;
}

/** Line diff (LCS). Specs are a few hundred lines at most, so O(n·m) is fine. */
export function lineDiff(left: string, right: string): DiffLine[] {
  const a = left.split("\n");
  const b = right.split("\n");
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) out.push({ op: " ", text: a[i]!, a: ++i, b: ++j });
    else if (j < b.length && (i >= a.length || dp[i]![j + 1]! > dp[i + 1]![j]!)) out.push({ op: "+", text: b[j]!, b: ++j });
    else out.push({ op: "-", text: a[i]!, a: ++i });
  }
  return out;
}

/** Groups a line diff into hunks with `context` unchanged lines around each change. */
export function hunks(lines: DiffLine[], context = 2): DiffLine[][] {
  const keep = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.op !== " ") for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: DiffLine[][] = [];
  let cur: DiffLine[] | null = null;
  lines.forEach((l, i) => {
    if (keep[i]) (cur ??= []).push(l);
    else if (cur) {
      out.push(cur);
      cur = null;
    }
  });
  if (cur) out.push(cur);
  return out;
}
