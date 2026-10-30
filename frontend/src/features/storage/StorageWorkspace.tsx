import { useDeferredValue, useMemo, useState } from "react";
import { Code, Database, Search, X } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { backend, type StorageClaim } from "@/backend/client";
import { Banner } from "@/components/ui/banner";
import { Button, IconButton } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { EmptyState } from "@/components/EmptyState";
import { Meter } from "@/components/ui/meter";
import { resourceTab } from "@/features/resources/kinds";
import { ago, BAR, Header, NeedsClusters, usePerCluster } from "@/features/insights/shared";
import { cn } from "@/lib/cn";
import { t as tt } from "@/i18n";

type Tab = "claims" | "volumes" | "classes";
interface Claim extends StorageClaim {
  cluster: string;
}

function bytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const usedPct = (c: StorageClaim) => (c.usedBytes !== undefined && c.capacityBytes ? Math.round((c.usedBytes / c.capacityBytes) * 100) : null);

/**
 * PersistentVolumeClaims, PersistentVolumes and StorageClasses of the selected
 * clusters: what is Pending and why, how full each volume is, and which pod
 * uses which disk.
 */
export function StorageWorkspace({ active }: { active: boolean }) {
  const ws = useWorkspace();
  const [tab, setTab] = useState<Tab>("claims");
  const [query, setQuery] = useState("");
  const [problems, setProblems] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const deferred = useDeferredValue(query);
  const { clusters, data, errors, loading, refresh } = usePerCluster((c) => backend!.storage(c), "", active, 60_000);

  const claims = useMemo<Claim[]>(() => Object.entries(data).flatMap(([cluster, r]) => r.claims.map((c) => ({ ...c, cluster }))), [data]);
  const pending = claims.filter((c) => c.health !== "healthy").length;
  const full = claims.filter((c) => (usedPct(c) ?? 0) >= 90).length;
  const unused = claims.filter((c) => c.health === "healthy" && c.pods.length === 0).length;
  const words = deferred.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (hay: string) => words.every((w) => hay.toLowerCase().includes(w));
  const shownClaims = claims.filter(
    (c) =>
      (!problems || c.health !== "healthy" || (usedPct(c) ?? 0) >= 90) &&
      match(`${c.cluster} ${c.namespace} ${c.name} ${c.class ?? ""} ${c.volume ?? ""} ${c.pods.map((p) => p.name).join(" ")}`),
  );
  const selected = claims.find((c) => c.id === selectedId) ?? null;
  const multi = clusters.length > 1;

  const empty = NeedsClusters({ icon: <Database />, title: tt("Storage"), clusters });
  if (empty) return empty;

  const usageNotes = Object.values(data).filter((r) => r.usage !== "kubelet");
  return (
    <div className="flex min-h-0 flex-1">
      <main className="flex min-w-0 flex-1 flex-col bg-surface-app">
        <Header icon={<Database />} title={tt("Storage")} sub={tt("{n} claims · {c} clusters", { n: claims.length, c: clusters.length })} onRefresh={refresh} loading={loading}>
          <Segmented
            aria-label={tt("Show")}
            value={tab}
            onValueChange={setTab}
            options={[
              { value: "claims", label: tt("Claims") },
              { value: "volumes", label: tt("Volumes") },
              { value: "classes", label: tt("Storage classes") },
            ]}
          />
        </Header>
        <div className={cn("flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-line py-2 pl-3.5 pr-3", BAR)}>
          <label className="flex h-7 w-[260px] shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-surface-panel pl-2 pr-1.5 text-fg-muted focus-within:border-accent">
            <Search className="size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">{tt("Filter storage")}</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tt("Filter name, namespace, class, pod…")}
              spellCheck={false}
              className="min-w-0 flex-1 border-0 bg-transparent text-cell text-fg outline-none placeholder:text-fg-muted"
            />
          </label>
          {tab === "claims" && (
            <button
              type="button"
              aria-pressed={problems}
              onClick={() => setProblems(!problems)}
              className={cn("focus-ring h-[26px] rounded-md border px-2 text-ui", problems ? "border-line-selected bg-accent-soft text-fg" : "border-line-strong text-fg")}
            >
              {tt("Problems only")}
            </button>
          )}
          <div className="flex-1" />
          {pending > 0 && <span className="rounded-full bg-status-critical-soft px-2 text-meta text-status-critical">{tt("{n} not bound", { n: pending })}</span>}
          {full > 0 && <span className="rounded-full bg-status-warning-soft px-2 text-meta text-status-warning">{tt("{n} over 90%", { n: full })}</span>}
          {unused > 0 && <span className="rounded-full bg-surface-hover px-2 text-meta text-fg-secondary">{tt("{n} not mounted", { n: unused })}</span>}
        </div>
        {Object.entries(errors).map(([c, e]) => (
          <Banner key={c} tone="warning" title={c} className="mx-3.5 mt-2.5">
            {e}
          </Banner>
        ))}
        {Object.values(data).flatMap((r) => [
          ...(r.scope ? [<Banner key={`${r.cluster}:scope`} tone="info" title={r.cluster} className="mx-3.5 mt-2.5">{tt("Only namespace {ns}: listing claims cluster-wide is not allowed for this identity.", { ns: r.scope })}</Banner>] : []),
          ...r.notes.map((n) => <Banner key={`${r.cluster}:${n}`} tone="info" title={r.cluster} className="mx-3.5 mt-2.5">{n}</Banner>),
        ])}
        {tab === "claims" && usageNotes.length > 0 && (
          <span className="px-3.5 pt-2 text-meta text-fg-muted">{tt("Usage: {v0}", { v0: usageNotes.map((r) => `${r.cluster} · ${r.usage}`).join("; ") })}</span>
        )}

        {tab === "claims" &&
          (shownClaims.length === 0 ? (
            <EmptyState className="flex-1" icon={<Database />} title={loading && !claims.length ? tt("Reading storage…") : tt("No claims match")} />
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full border-collapse text-ui">
                <thead className="sticky top-0 z-[1] bg-surface-app text-left text-meta text-fg-muted">
                  <tr className="border-b border-line">
                    <th className="w-6 py-1.5 pl-3.5" aria-label={tt("Status")} />
                    <th className="px-2 py-1.5 font-medium">{tt("Claim")}</th>
                    <th className="px-2 py-1.5 font-medium">{tt("Namespace")}</th>
                    <th className="px-2 py-1.5 font-medium">{tt("Size")}</th>
                    <th className="w-[150px] px-2 py-1.5 font-medium">{tt("Used")}</th>
                    <th className="px-2 py-1.5 font-medium">{tt("Class · access")}</th>
                    <th className="px-2 py-1.5 font-medium">{tt("Mounted by")}</th>
                    {multi && <th className="px-2 py-1.5 font-medium">{tt("Cluster")}</th>}
                    <th className="py-1.5 pl-2 pr-3.5 text-right font-medium">{tt("Age")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shownClaims.map((c) => {
                    const pct = usedPct(c);
                    return (
                      <tr
                        key={c.id}
                        aria-selected={c.id === selectedId}
                        onClick={() => setSelectedId(c.id)}
                        className={cn("cursor-pointer border-b border-line-row align-top hover:bg-surface-hover", c.id === selectedId && "bg-surface-selected")}
                      >
                        <td className="py-2 pl-3.5">
                          <StatusGlyph health={c.health === "healthy" && (pct ?? 0) >= 90 ? "warning" : c.health} />
                        </td>
                        <td className="max-w-[260px] px-2 py-1.5">
                          <span className="block truncate font-mono" title={c.name}>
                            {c.name}
                          </span>
                          <span className={cn("block truncate text-meta", c.health === "healthy" ? "text-fg-muted" : "text-status-critical")} title={c.reason}>
                            {c.phase}
                            {c.reason ? ` · ${c.reason}` : c.volume ? ` · ${c.volume}` : ""}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-fg-secondary">{c.namespace}</td>
                        <td className="px-2 py-2 font-mono">{c.capacity || c.requested}</td>
                        <td className="px-2 py-2">
                          {pct === null ? (
                            <span className="text-meta text-fg-muted">—</span>
                          ) : (
                            <span className="flex items-center gap-1.5" title={`${bytes(c.usedBytes!)} / ${bytes(c.capacityBytes!)}`}>
                              <Meter value={pct / 100} label={tt("{v0} used", { v0: c.name })} className={cn("flex-1", pct >= 90 && "[&>*]:bg-status-warning")} />
                              <span className="w-9 text-right font-mono text-meta text-fg-secondary">{pct}%</span>
                            </span>
                          )}
                        </td>
                        <td className="max-w-[200px] truncate px-2 py-2 text-fg-secondary">
                          {c.class || "—"} · {c.accessModes.map((m) => m.replace(/[a-z]/g, "")).join(", ")}
                        </td>
                        <td className="max-w-[240px] truncate px-2 py-2 font-mono text-cell" title={c.pods.map((p) => p.name).join(", ")}>
                          {c.pods.length ? c.pods.map((p) => p.name).join(", ") : <span className="font-sans text-fg-muted">{tt("not mounted")}</span>}
                        </td>
                        {multi && (
                          <td className="px-2 py-2">
                            <span className="flex items-center gap-1.5">
                              <EnvironmentBadge env={ws.clusterById(c.cluster)?.env ?? "dev"} />
                              {c.cluster}
                            </span>
                          </td>
                        )}
                        <td className="py-2 pl-2 pr-3.5 text-right font-mono text-meta text-fg-muted">{ago(c.created)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}

        {tab === "volumes" && (
          <SimpleTable
            head={[tt("Volume"), tt("Status"), tt("Size"), tt("Class"), tt("Claim"), tt("Reclaim"), tt("Source"), ...(multi ? [tt("Cluster")] : [])]}
            rows={Object.entries(data).flatMap(([cluster, r]) =>
              r.volumes
                .filter((v) => match(`${cluster} ${v.name} ${v.class ?? ""} ${v.claim ?? ""} ${v.source}`))
                .map((v) => ({
                  key: `${cluster}/${v.name}`,
                  cells: [
                    <span key="n" className="flex items-center gap-1.5 font-mono">
                      <StatusGlyph health={v.health} />
                      {v.name}
                    </span>,
                    <span key="p" title={v.reason}>{v.phase}{v.reason ? ` · ${v.reason}` : ""}</span>,
                    <span key="s" className="font-mono">{v.capacity}</span>,
                    v.class || "—",
                    <span key="c" className="font-mono">{v.claim || "—"}</span>,
                    v.reclaimPolicy,
                    <span key="src" className="font-mono text-meta">{v.source}</span>,
                    ...(multi ? [cluster] : []),
                  ],
                })),
            )}
          />
        )}
        {tab === "classes" && (
          <SimpleTable
            head={[tt("Storage class"), tt("Provisioner"), tt("Binding"), tt("Reclaim"), tt("Expansion"), tt("Claims"), ...(multi ? [tt("Cluster")] : [])]}
            rows={Object.entries(data).flatMap(([cluster, r]) =>
              r.classes
                .filter((s) => match(`${cluster} ${s.name} ${s.provisioner}`))
                .map((s) => ({
                  key: `${cluster}/${s.name}`,
                  cells: [
                    <span key="n" className="font-mono">
                      {s.name}
                      {s.default && <span className="ml-1.5 rounded bg-accent-soft px-1 font-sans text-meta text-fg">{tt("default")}</span>}
                    </span>,
                    <span key="p" className="font-mono text-meta">{s.provisioner}</span>,
                    s.bindingMode,
                    s.reclaimPolicy,
                    s.expansion ? tt("allowed") : tt("no"),
                    String(s.claims),
                    ...(multi ? [cluster] : []),
                  ],
                })),
            )}
          />
        )}
      </main>
      {tab === "claims" && selected && <ClaimInspector claim={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function SimpleTable({ head, rows }: { head: string[]; rows: { key: string; cells: React.ReactNode[] }[] }) {
  if (!rows.length) return <EmptyState className="flex-1" icon={<Database />} title={tt("Nothing to show")} />;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-ui">
        <thead className="sticky top-0 bg-surface-app text-left text-meta text-fg-muted">
          <tr className="border-b border-line">
            {head.map((h, i) => (
              <th key={h} className={cn("py-1.5 font-medium", i === 0 ? "pl-3.5 pr-2" : "px-2")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-line-row">
              {r.cells.map((c, i) => (
                <td key={i} className={cn("py-1.5", i === 0 ? "pl-3.5 pr-2" : "px-2")}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClaimInspector({ claim: c, onClose }: { claim: Claim; onClose: () => void }) {
  const ws = useWorkspace();
  const bound = c.health === "healthy";
  return (
    <aside aria-label={tt("Claim details")} className="flex w-[360px] shrink-0 flex-col gap-3.5 overflow-y-auto border-l border-line bg-surface-panel px-3.5 py-3">
      <div className="flex items-start gap-1.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="selectable truncate font-mono text-ui font-semibold">{c.name}</span>
          <span className="text-meta text-fg-muted">
            PersistentVolumeClaim · {c.namespace} · {c.cluster}
          </span>
        </div>
        <IconButton aria-label={tt("Close inspector")} onClick={onClose}>
          <X />
        </IconButton>
      </div>
      {!bound && (
        <div className="flex flex-col gap-1 rounded-lg bg-status-critical-soft px-3 py-2">
          <span className="font-semibold text-status-critical">{tt("{phase} for {age}", { phase: c.phase, age: ago(c.created) })}</span>
          <span className="selectable text-meta text-fg-secondary">{c.reason || tt("No events: the API server keeps them for about an hour.")}</span>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <span className="section-label">{tt("Chain")}</span>
        <dl className="m-0 grid grid-cols-[84px_1fr] gap-x-2 gap-y-1.5 text-ui">
          <dt className="text-fg-muted">{tt("Pods")}</dt>
          <dd className="m-0 flex flex-col gap-0.5 font-mono text-cell">
            {c.pods.length ? (
              c.pods.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className="focus-ring truncate text-left text-accent hover:underline"
                  onClick={() => {
                    ws.openView({ kind: "pods", title: tt("Pods") });
                    ws.revealResource("pod", `${c.cluster}/${c.namespace}/${p.name}`);
                  }}
                >
                  {p.name} <span className="font-sans text-meta text-fg-muted">{p.phase}{p.node ? ` · ${p.node}` : ""}</span>
                </button>
              ))
            ) : (
              <span className="font-sans text-fg-muted">{tt("not mounted")}</span>
            )}
          </dd>
          {c.pods[0]?.owner && (
            <>
              <dt className="text-fg-muted">{tt("Owner")}</dt>
              <dd className="m-0 truncate font-mono text-cell">{c.pods[0].owner}</dd>
            </>
          )}
          <dt className="text-fg-muted">{tt("Class")}</dt>
          <dd className="m-0 font-mono text-cell">{c.class || "—"}</dd>
          <dt className="text-fg-muted">{tt("Volume")}</dt>
          <dd className="m-0 truncate font-mono text-cell">{c.volume || <span className="font-sans text-fg-muted">{tt("none yet")}</span>}</dd>
          {c.usedBytes !== undefined && c.capacityBytes !== undefined && (
            <>
              <dt className="text-fg-muted">{tt("Used")}</dt>
              <dd className="m-0 font-mono text-cell">
                {bytes(c.usedBytes)} / {bytes(c.capacityBytes)}
              </dd>
            </>
          )}
        </dl>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="section-label">{tt("Requested")}</span>
        <div className="flex flex-wrap gap-1.5">
          {[c.requested, ...c.accessModes, c.volumeMode].filter(Boolean).map((x) => (
            <span key={x} className="rounded border border-line-strong px-1.5 py-0.5 font-mono text-meta">
              {x}
            </span>
          ))}
        </div>
      </div>
      <div className="flex gap-1.5">
        <Button onClick={() => ws.openView(resourceTab(c.cluster, "PersistentVolumeClaim", c.namespace, c.name))}>{tt("Events")}</Button>
        <Button onClick={() => ws.openView({ kind: "yaml", title: `YAML · ${c.name}`, cluster: c.cluster, params: { kind: "PersistentVolumeClaim", namespace: c.namespace, name: c.name } })}>
          <Code aria-hidden />
          YAML
        </Button>
      </div>
    </aside>
  );
}
