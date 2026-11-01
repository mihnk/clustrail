import { useMemo, useState } from "react";
import { ArchiveX, Copy } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { backend, type APIRemovalFinding, type APIRemovalReport } from "@/backend/client";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { EmptyState } from "@/components/EmptyState";
import { resourceTab } from "@/features/resources/kinds";
import { cn } from "@/lib/cn";
import { Header, NeedsClusters, usePerCluster } from "./shared";
import { t as tt } from "@/i18n";

/** Minor version of "1.25"; 0 for "" (no removal set). */
export function minorOf(release: string): number {
  const m = /^1\.(\d+)$/.exec(release);
  return m ? Number(m[1]) : 0;
}

export type RemovalState = "gone" | "target" | "later" | "unset";

/** Where a finding stands for a cluster at `minor` upgrading to `target`. */
export function removalState(f: APIRemovalFinding, minor: number, target: number): RemovalState {
  const r = minorOf(f.removed);
  if (!r) return "unset";
  if (minor && r <= minor) return "gone";
  if (r <= target) return "target";
  return "later";
}

type Row = APIRemovalFinding & { cluster: string; minor: number; state: RemovalState; key: string };

const SOURCE = (s: APIRemovalFinding["source"]) => (s === "helm" ? "Helm" : s === "applied" ? tt("kubectl apply") : tt("API server"));

function objectLabel(f: APIRemovalFinding): string {
  if (f.source === "apiserver") return f.resource ?? "";
  return f.namespace ? `${f.namespace}/${f.name}` : (f.name ?? "");
}

function whereLabel(f: APIRemovalFinding, started?: string): string {
  if (f.source === "helm") return f.hook ? tt("hook of release {r}, revision {n}", { r: f.release ?? "", n: f.revision ?? 0 }) : tt("release {r}, revision {n}", { r: f.release ?? "", n: f.revision ?? 0 });
  if (f.source === "applied") return tt("last-applied annotation");
  return started ? tt("requested since the API server started, {d}", { d: started.slice(0, 10) }) : tt("requested since the API server started");
}

/**
 * API versions a Kubernetes release stops serving, and what records that they
 * are in use: Helm release manifests, kubectl's last-applied annotation and the
 * API server's own count of deprecated requests. Live objects are not read:
 * the API server returns them in whichever version is asked for.
 */
export function ApiRemovalsWorkspace({ active }: { active: boolean }) {
  const ws = useWorkspace();
  const { clusters, data, errors, loading, refresh } = usePerCluster("apiremovals", (c) => backend!.apiRemovals(c), "", active, 0);
  const reports = Object.values(data) as APIRemovalReport[];
  const minors = reports.map((r) => r.minor).filter((m) => m > 0);
  const lowest = minors.length ? Math.min(...minors) : 0;
  const [picked, setPicked] = useState<number | null>(null);
  const target = picked ?? (lowest ? lowest + 1 : 0);
  const [selected, setSelected] = useState<string | null>(null);

  const rows = useMemo<Row[]>(
    () =>
      reports.flatMap((r) =>
        r.findings.map((f, i) => ({ ...f, cluster: r.cluster, minor: r.minor, state: removalState(f, r.minor, target), key: `${r.cluster}#${i}` })),
      ),
    [reports, target],
  );
  const shown = rows.filter((r) => r.state === "gone" || r.state === "target");
  const unset = rows.filter((r) => r.state === "unset");
  const gone = shown.filter((r) => r.state === "gone").length;
  const byTarget = shown.length - gone;
  const clean = reports.filter((r) => !shown.some((x) => x.cluster === r.cluster)).map((r) => r.cluster);
  const sel = shown.find((r) => r.key === selected) ?? shown[0];

  const empty = NeedsClusters({ icon: <ArchiveX />, title: tt("API removals"), clusters });
  if (empty) return empty;

  const versions = reports.map((r) => r.server).filter(Boolean);
  const sub = versions.length
    ? tt("{n} clusters · running {v}", { n: reports.length, v: [...new Set(versions)].sort().join(", ") })
    : tt("{n} clusters", { n: clusters.length });
  const targets = lowest ? [1, 2, 3, 4].map((d) => lowest + d) : [];

  const copy = () => {
    const lines = shown.map((r) => [r.cluster, r.removed, `${r.apiVersion} ${r.kind ?? r.resource ?? ""}`.trim(), r.replacement ?? "", SOURCE(r.source), objectLabel(r)].join("\t"));
    void navigator.clipboard?.writeText(["cluster\tremoved\tapi\tinstead\tsource\tobject", ...lines].join("\n"));
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-app">
      <Header icon={<ArchiveX />} title={tt("API removals")} sub={sub} onRefresh={refresh} loading={loading}>
        {targets.length > 0 && (
          <>
            <span className="text-meta text-fg-muted">{tt("Upgrading to")}</span>
            <Segmented
              aria-label={tt("Target version")}
              value={String(target)}
              onValueChange={(v) => setPicked(Number(v))}
              options={targets.map((m) => ({ value: String(m), label: <span className="font-mono">1.{m}</span> }))}
            />
          </>
        )}
        <Button size="sm" onClick={copy} disabled={!shown.length}>
          <Copy /> {tt("Copy as list")}
        </Button>
      </Header>
      <Banner tone="info" className="mx-3.5 mt-2.5">
        {tt(
          "Only what records the version that was used: Helm release manifests, kubectl's last-applied annotation and the API server's own count of deprecated requests. A live object cannot tell: the API server returns it in whichever version is asked for. Removal versions come from Kubernetes' API lifecycle tags.",
        )}
      </Banner>
      {Object.entries(errors).map(([c, e]) => (
        <Banner key={c} tone="warning" title={c} className="mx-3.5 mt-2.5">
          {e}
        </Banner>
      ))}

      <div className="flex gap-2.5 px-3.5 pt-2.5">
        <Summary n={gone} tone="critical" title={tt("Already removed on the cluster")} detail={tt("Fails today: Helm cannot upgrade these releases")} />
        <Summary n={byTarget} tone="warning" title={tt("Removed by 1.{m}", { m: target })} detail={tt("Fails once the control plane is upgraded")} />
        <Summary n={clean.length} tone="healthy" title={tt("Clusters with nothing recorded")} detail={clean.length ? clean.join(", ") : "—"} />
      </div>

      <div className="flex min-h-0 flex-1 gap-3.5 p-3.5">
        <section aria-label={tt("Findings")} className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface-panel">
          {shown.length === 0 ? (
            <EmptyState className="flex-1" icon={<StatusGlyph health="healthy" />} title={loading && !reports.length ? tt("Reading Helm releases, annotations and API server metrics…") : tt("Nothing recorded uses an API removed by 1.{m}", { m: target })}>
              {reports.length ? tt("{r} Helm releases and {o} objects checked.", { r: sum(reports, "releases"), o: sum(reports, "objects") }) : undefined}
            </EmptyState>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <table className="w-full border-collapse text-ui">
                <thead className="sticky top-0 bg-surface-panel text-left text-meta text-fg-muted">
                  <tr className="border-b border-line">
                    <th className="py-1.5 pl-3.5 pr-2 font-medium">{tt("Removed in")}</th>
                    <th className="px-2 py-1.5 font-medium">{tt("API used → use instead")}</th>
                    <th className="px-2 py-1.5 font-medium">{tt("Recorded by")}</th>
                    <th className="px-2 py-1.5 font-medium">{tt("Object")}</th>
                    <th className="py-1.5 pl-2 pr-3.5 font-medium">{tt("Cluster")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr
                      key={r.key}
                      aria-selected={r.key === sel?.key}
                      onClick={() => setSelected(r.key)}
                      className={cn("cursor-default border-b border-line-row align-top", r.key === sel?.key ? "bg-surface-selected" : r.state === "gone" && "bg-status-critical/5")}
                    >
                      <td className="py-2 pl-3.5 pr-2">
                        <ReleaseBadge release={r.removed} gone={r.state === "gone"} />
                      </td>
                      <td className="px-2 py-2">
                        <span className="block font-mono">
                          {r.apiVersion} {r.kind ?? ""}
                        </span>
                        <span className="block font-mono text-meta text-status-healthy">{r.replacement ? `→ ${r.replacement}` : tt("→ no replacement")}</span>
                      </td>
                      <td className="px-2 py-2">
                        <span className="rounded-full bg-surface-hover px-2 py-0.5 text-meta">{SOURCE(r.source)}</span>
                      </td>
                      <td className="max-w-[320px] px-2 py-2">
                        <span className="block truncate font-mono text-accent">{objectLabel(r)}</span>
                        <span className="block text-meta text-fg-muted">{whereLabel(r, data[r.cluster]?.apiServerStarted)}</span>
                      </td>
                      <td className="whitespace-nowrap py-2 pl-2 pr-3.5">
                        <span className="flex items-center gap-1.5">
                          <EnvironmentBadge env={ws.clusterById(r.cluster)?.env ?? "dev"} />
                          {r.cluster}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Footer reports={reports} unset={unset} />
        </section>
        {sel && <Detail row={sel} started={data[sel.cluster]?.apiServerStarted} target={target} />}
      </div>
    </main>
  );
}

function sum(reports: APIRemovalReport[], k: "releases" | "objects") {
  return reports.reduce((n, r) => n + r[k], 0);
}

function Summary({ n, tone, title, detail }: { n: number; tone: "critical" | "warning" | "healthy"; title: string; detail: string }) {
  return (
    <div className={cn("flex flex-1 flex-col gap-0.5 rounded-lg border bg-surface-panel px-3.5 py-2.5", n && tone === "critical" ? "border-status-critical/40" : n && tone === "warning" ? "border-status-warning/40" : "border-line")}>
      <span className={cn("text-[22px] font-semibold", n === 0 ? "text-fg-muted" : tone === "critical" ? "text-status-critical" : tone === "warning" ? "text-status-warning" : "text-status-healthy")}>{n}</span>
      <span className="text-fg-secondary">{title}</span>
      <span className="truncate text-meta text-fg-muted" title={detail}>
        {detail}
      </span>
    </div>
  );
}

function ReleaseBadge({ release, gone }: { release: string; gone: boolean }) {
  return <span className={cn("rounded px-1.5 py-0.5 font-mono text-meta font-semibold", gone ? "bg-status-critical/15 text-status-critical" : "bg-status-warning/15 text-status-warning")}>{release}</span>;
}

function Footer({ reports, unset }: { reports: APIRemovalReport[]; unset: Row[] }) {
  const notes = reports.flatMap((r) => r.notes.map((n) => `${r.cluster}: ${n}`));
  if (!notes.length && !unset.length) return null;
  return (
    <div className="flex flex-col gap-1 border-t border-line px-3.5 py-2 text-meta text-fg-muted">
      {unset.length > 0 && (
        <span>
          {tt("Deprecated, no removal release set:")}{" "}
          <span className="font-mono">{[...new Set(unset.map((u) => `${u.apiVersion} ${u.kind ?? u.resource ?? ""}`.trim()))].join(", ")}</span>
        </span>
      )}
      {notes.map((n) => (
        <span key={n}>{tt("Not checked:")} {n}</span>
      ))}
    </div>
  );
}

function Detail({ row, started, target }: { row: Row; started?: string; target: number }) {
  const ws = useWorkspace();
  const gone = row.state === "gone";
  const instead = row.replacement;
  const label = "text-[11px] font-semibold uppercase tracking-[.06em] text-fg-secondary";
  let means: string;
  let fix: string;
  if (row.source === "helm") {
    means = gone
      ? tt("Helm reads this manifest to find the release's current objects, so helm upgrade of this release fails until the stored manifest changes.")
      : tt("After the upgrade to 1.{m}, helm upgrade of this release fails until the stored manifest changes. Upgrade the release with a chart that uses the new version first.", { m: target });
    fix = instead
      ? tt("Use {v} in the chart. For a revision already stored, the helm-mapkubeapis plugin rewrites it.", { v: instead })
      : tt("The API was dropped without a replacement: remove the object from the chart.");
  } else if (row.source === "applied") {
    means = gone
      ? tt("kubectl apply last wrote this object from a file with {v}. The object is fine; applying that file again fails, because the API server no longer serves {v}.", { v: row.apiVersion })
      : tt("kubectl apply last wrote this object from a file with {v}. The object is fine; applying that file again fails after the upgrade.", { v: row.apiVersion });
    fix = instead ? tt("Change apiVersion to {v} in the file and apply it again; that also updates the annotation.", { v: instead }) : tt("The API was dropped without a replacement: delete the object or stop applying it.");
  } else {
    means = tt("A client requested {v} {r} since this API server started{d}. The metric does not say which client; the API server's audit log does. With several API servers, only the one that answered is counted.", {
      v: row.apiVersion,
      r: row.resource ?? "",
      d: started ? ` (${started.slice(0, 10)})` : "",
    });
    fix = instead ? tt("Move that client to {v}.", { v: instead }) : tt("The API was dropped without a replacement: the client has to stop using it.");
  }
  const openable = row.source === "applied" && row.kind && row.name;
  return (
    <aside aria-label={tt("Selected finding")} className="flex w-[380px] shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-surface-panel p-4">
      <span className={label}>
        {SOURCE(row.source)}
        {row.source === "helm" ? ` · ${tt("revision {n}", { n: row.revision ?? 0 })}` : ""}
      </span>
      <span className="font-mono">{row.source === "helm" ? `${row.namespace}/${row.release}` : objectLabel(row)}</span>
      <span className="flex items-center gap-2">
        <ReleaseBadge release={row.removed} gone={gone} />
        <span className={cn("text-meta", gone ? "text-status-critical" : "text-status-warning")}>
          {gone ? tt("Already removed on this cluster ({v})", { v: `1.${row.minor}` }) : tt("Removed in {v}; this cluster runs 1.{m}", { v: row.removed, m: row.minor })}
        </span>
      </span>
      <pre className="m-0 whitespace-pre-wrap rounded-md border border-line bg-surface-app p-2.5 font-mono text-meta text-fg-secondary">
        <span className="text-status-critical">apiVersion: {row.apiVersion}</span>
        {"\n"}
        {row.kind ? `kind: ${row.kind}\n` : `resource: ${row.resource}\n`}
        {row.name ? `metadata:\n  name: ${row.name}` : ""}
      </pre>
      <span className={cn(label, "mt-1")}>{tt("What this means")}</span>
      <span className="leading-relaxed text-fg">{means}</span>
      <span className={cn(label, "mt-1")}>{tt("To fix")}</span>
      <span className="leading-relaxed text-fg">{fix}</span>
      <div className="mt-auto flex gap-2">
        {row.source === "helm" && (
          <Button size="sm" onClick={() => ws.openView({ kind: "helm", title: tt("Helm releases") })}>
            {tt("Helm releases")}
          </Button>
        )}
        {openable && (
          <Button size="sm" onClick={() => ws.openView(resourceTab(row.cluster, row.kind!, row.namespace ?? "", row.name!))}>
            {tt("Open the object")}
          </Button>
        )}
      </div>
    </aside>
  );
}
