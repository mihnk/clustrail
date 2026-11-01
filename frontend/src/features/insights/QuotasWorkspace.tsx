import { useMemo, useState } from "react";
import { Gauge, Search } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { backend, type LimitRangeInfo, type QuotaInfo, type QuotaItem, type QuotaReport, type QuotaRule } from "@/backend/client";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { TextField } from "@/components/ui/text-field";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { EmptyState } from "@/components/EmptyState";
import { resourceTab } from "@/features/resources/kinds";
import { cn } from "@/lib/cn";
import { Header, NeedsClusters, usePerCluster } from "./shared";
import { t as tt } from "@/i18n";

type Space = { cluster: string; namespace: string; quotas: QuotaInfo[]; limits: LimitRangeInfo[]; rules: QuotaRule[]; full: number; top: number };

/** One entry per cluster and namespace that has a quota or a LimitRange. */
export function namespacesOf(reports: QuotaReport[]): Space[] {
  const out = new Map<string, Space>();
  const get = (cluster: string, namespace: string) => {
    const k = `${cluster}/${namespace}`;
    let s = out.get(k);
    if (!s) out.set(k, (s = { cluster, namespace, quotas: [], limits: [], rules: [], full: 0, top: 0 }));
    return s;
  };
  for (const r of reports) {
    for (const q of r.quotas) {
      const s = get(r.cluster, q.namespace);
      s.quotas.push(q);
      for (const it of q.items) {
        if (it.full) s.full++;
        s.top = Math.max(s.top, it.full ? Math.max(1, it.ratio) : it.ratio);
      }
    }
    for (const l of r.limits) get(r.cluster, l.namespace).limits.push(l);
    for (const rule of r.rules) get(r.cluster, rule.namespace).rules.push(rule);
  }
  return [...out.values()];
}

const RES_NAME = (resource: string) => resource.replace(/^(requests|limits)\./, "");

export function ruleText(r: QuotaRule): string {
  const res = RES_NAME(r.resource);
  if (r.kind === "defaults") {
    return r.resource.startsWith("limits.")
      ? tt("A container without a {r} limit gets {v} (LimitRange).", { r: res, v: r.value ?? "" })
      : tt("A container without a {r} request gets {v} (LimitRange).", { r: res, v: r.value ?? "" });
  }
  return r.resource.startsWith("limits.")
    ? tt("Containers must set a {r} limit: a pod without one is refused (quota {q}).", { r: res, q: r.quota ?? "" })
    : tt("Containers must set a {r} request or limit: a pod without one is refused (quota {q}).", { r: res, q: r.quota ?? "" });
}

/**
 * ResourceQuotas with the use the API server counts (status.used against
 * status.hard), LimitRanges as written, and two rules that follow from the
 * admission plugins: what a container without requests gets, and which pods
 * an unscoped quota refuses.
 */
export function QuotasWorkspace({ active }: { active: boolean }) {
  const ws = useWorkspace();
  const { clusters, data, errors, loading, refresh } = usePerCluster("quotas", (c) => backend!.quotas(c), "", active, 0);
  const [order, setOrder] = useState<"full" | "name">("full");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const reports = Object.values(data) as QuotaReport[];
  const spaces = useMemo(() => {
    const all = namespacesOf(reports).filter((s) => !filter || s.namespace.includes(filter.trim()));
    return all.sort((a, b) =>
      order === "full" && a.top !== b.top ? b.top - a.top : a.namespace === b.namespace ? a.cluster.localeCompare(b.cluster) : a.namespace.localeCompare(b.namespace),
    );
  }, [reports, order, filter]);
  const withQuota = spaces.filter((s) => s.quotas.length);
  const limitsOnly = spaces.filter((s) => !s.quotas.length);
  const fullCount = withQuota.filter((s) => s.full > 0).length;
  const sel = spaces.find((s) => `${s.cluster}/${s.namespace}` === selected) ?? withQuota[0] ?? limitsOnly[0];

  const empty = NeedsClusters({ icon: <Gauge />, title: tt("Quotas and limits"), clusters });
  if (empty) return empty;

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-app">
      <Header
        icon={<Gauge />}
        title={tt("Quotas and limits")}
        sub={tt("{n} namespaces with a quota · {f} full · {c} clusters", { n: withQuota.length, f: fullCount, c: reports.length })}
        onRefresh={refresh}
        loading={loading}
      >
        <Segmented
          aria-label={tt("Order")}
          value={order}
          onValueChange={setOrder}
          options={[
            { value: "full", label: tt("Fullest first") },
            { value: "name", label: tt("By namespace") },
          ]}
        />
        <TextField aria-label={tt("Filter namespaces")} placeholder={tt("Filter namespaces")} value={filter} onChange={(e) => setFilter(e.target.value)} leading={<Search />} className="w-[180px]" />
      </Header>
      {Object.entries(errors).map(([c, e]) => (
        <Banner key={c} tone="warning" title={c} className="mx-3.5 mt-2.5">
          {e}
        </Banner>
      ))}
      {reports.flatMap((r) =>
        r.notes.map((n) => (
          <Banner key={`${r.cluster}:${n}`} tone="info" title={r.cluster} className="mx-3.5 mt-2.5">
            {n}
          </Banner>
        )),
      )}
      {spaces.length === 0 ? (
        <EmptyState className="flex-1" icon={<StatusGlyph health="healthy" />} title={loading && !reports.length ? tt("Reading quotas…") : tt("No ResourceQuota or LimitRange")}>
          {reports.length ? tt("Namespaces without a quota can create as much as the cluster allows.") : undefined}
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3.5 p-3.5">
          <section aria-label={tt("Quotas")} className="flex min-w-0 flex-1 flex-col gap-2.5 overflow-y-auto">
            {withQuota.map((s) => (
              <SpaceCard key={`${s.cluster}/${s.namespace}`} space={s} env={ws.clusterById(s.cluster)?.env ?? "dev"} selected={s === sel} onSelect={() => setSelected(`${s.cluster}/${s.namespace}`)} />
            ))}
            {limitsOnly.length > 0 && (
              <div className="rounded-lg border border-line bg-surface-panel px-3.5 py-2.5">
                <span className="text-meta text-fg-muted">{tt("LimitRange, no quota:")} </span>
                {limitsOnly.map((s, i) => (
                  <span key={`${s.cluster}/${s.namespace}`}>
                    {i > 0 && ", "}
                    <button type="button" className="focus-ring font-mono text-accent hover:underline" onClick={() => setSelected(`${s.cluster}/${s.namespace}`)}>
                      {s.namespace}
                    </button>
                    <span className="text-meta text-fg-muted"> ({s.cluster})</span>
                  </span>
                ))}
              </div>
            )}
          </section>
          {sel && <SpaceDetail space={sel} />}
        </div>
      )}
    </main>
  );
}

function Bar({ item }: { item: QuotaItem }) {
  const pct = Math.max(0, Math.min(1, item.ratio));
  return (
    <span role="meter" aria-label={item.resource} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)} className="flex h-1.5 flex-1 overflow-hidden rounded-sm bg-line-strong">
      <i className={cn("block h-full", item.full ? "bg-status-critical" : "bg-accent")} style={{ width: `${pct * 100}%` }} />
    </span>
  );
}

function SpaceCard({ space, env, selected, onSelect }: { space: Space; env: Parameters<typeof EnvironmentBadge>[0]["env"]; selected: boolean; onSelect: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}
      className={cn("focus-ring overflow-hidden rounded-lg border bg-surface-panel text-left", selected ? "border-accent" : space.full ? "border-status-critical/40" : "border-line")}
    >
      <div className={cn("flex items-center gap-2.5 border-b border-line-row px-3.5 py-2", selected && "bg-surface-selected")}>
        <span className="font-mono font-medium">{space.namespace}</span>
        <EnvironmentBadge env={env} />
        <span className="truncate text-meta text-fg-muted">{space.cluster}</span>
        <span className="flex-1" />
        <span className={cn("text-meta font-medium", space.full ? "text-status-critical" : "text-status-healthy")}>{space.full ? tt("{n} full", { n: space.full }) : tt("room left")}</span>
      </div>
      {space.quotas.map((q) => (
        <div key={q.name} className="flex flex-col gap-1.5 px-3.5 py-2.5">
          <span className="text-meta text-fg-muted">
            {tt("ResourceQuota {q}", { q: q.name })}
            {q.scopes.length > 0 && ` · ${tt("scope")} ${q.scopes.join(", ")}`}
          </span>
          <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)_120px] items-center gap-x-3.5 gap-y-1.5">
            {q.items.map((it) => (
              <QuotaRow key={it.resource} item={it} />
            ))}
          </div>
        </div>
      ))}
      {space.rules.some((r) => r.kind === "needs") && (
        <div className="px-3.5 pb-2.5 text-meta text-status-critical">
          {space.rules
            .filter((r) => r.kind === "needs")
            .map((r) => ruleText(r))
            .join(" ")}
        </div>
      )}
    </div>
  );
}

function QuotaRow({ item }: { item: QuotaItem }) {
  return (
    <>
      <span className="truncate font-mono text-fg-secondary">{item.resource}</span>
      <Bar item={item} />
      <span className={cn("text-right font-mono", item.full ? "text-status-critical" : "text-fg-secondary")}>
        {item.used} / {item.hard}
      </span>
    </>
  );
}

function SpaceDetail({ space }: { space: Space }) {
  const ws = useWorkspace();
  const label = "text-[11px] font-semibold uppercase tracking-[.06em] text-fg-secondary";
  const full = space.quotas.flatMap((q) => q.items.filter((it) => it.full).map((it) => ({ q, it })));
  const limits = space.limits.flatMap((l) => l.items.map((it) => ({ l, it })));
  return (
    <aside aria-label={tt("Selected namespace")} className="flex w-[380px] shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-surface-panel p-4">
      <span className={label}>{tt("Namespace · {c}", { c: space.cluster })}</span>
      <span className="font-mono">{space.namespace}</span>
      {full.map(({ q, it }) => (
        <Banner key={`${q.name}/${it.resource}`} tone="critical">
          {tt("{r} {u} / {h}: the API server refuses anything that adds to it in this namespace (“exceeded quota: {q}”).", { r: it.resource, u: it.used, h: it.hard, q: q.name })}
        </Banner>
      ))}
      {space.limits.length > 0 && (
        <>
          <span className={cn(label, "mt-1")}>{tt("LimitRange {n}", { n: space.limits.map((l) => l.name).join(", ") })}</span>
          <table className="w-full border-collapse rounded-md border border-line bg-surface-app text-meta">
            <thead className="text-left text-fg-muted">
              <tr>
                <th className="px-2 py-1.5 font-normal" />
                <th className="px-2 py-1.5 font-normal">{tt("default request")}</th>
                <th className="px-2 py-1.5 font-normal">{tt("default limit")}</th>
                <th className="px-2 py-1.5 font-normal">{tt("min")}</th>
                <th className="px-2 py-1.5 font-normal">{tt("max")}</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {limits.map(({ l, it }) => (
                <tr key={`${l.name}/${it.type}/${it.resource}`} className="border-t border-line-row">
                  <td className="px-2 py-1.5 font-sans text-fg-secondary">
                    {it.type} {it.resource}
                  </td>
                  <td className="px-2 py-1.5">{it.defaultRequest || "—"}</td>
                  <td className="px-2 py-1.5">{it.default || "—"}</td>
                  <td className="px-2 py-1.5">{it.min || "—"}</td>
                  <td className="px-2 py-1.5">{it.max || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {(space.rules.length > 0 || limits.some(({ it }) => it.max)) && (
        <>
          <span className={cn(label, "mt-1")}>{tt("What a new pod gets here")}</span>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 leading-relaxed">
            {space.rules.map((r) => (
              <li key={r.resource} className={r.kind === "needs" ? "text-status-critical" : "text-fg"}>
                {ruleText(r)}
              </li>
            ))}
            {limits
              .filter(({ it }) => it.max && (it.type === "Container" || it.type === "Pod" || it.type === "PersistentVolumeClaim"))
              .map(({ l, it }) => (
                <li key={`max/${l.name}/${it.type}/${it.resource}`} className="text-fg">
                  {it.type === "Container"
                    ? tt("A container with a {r} request or limit above {v} is refused.", { v: it.max ?? "", r: it.resource })
                    : it.type === "Pod"
                      ? tt("A pod whose containers' {r} limits add up to more than {v} is refused.", { v: it.max ?? "", r: it.resource })
                      : tt("A PersistentVolumeClaim requesting more than {v} {r} is refused.", { v: it.max ?? "", r: it.resource })}
                </li>
              ))}
          </ul>
        </>
      )}
      <div className="mt-auto flex gap-2">
        {space.quotas[0] && (
          <Button size="sm" onClick={() => ws.openView(resourceTab(space.cluster, "ResourceQuota", space.namespace, space.quotas[0]!.name))}>
            {tt("Open the quota")}
          </Button>
        )}
      </div>
    </aside>
  );
}
