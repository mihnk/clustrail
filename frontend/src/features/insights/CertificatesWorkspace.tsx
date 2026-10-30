import { useMemo, useState } from "react";
import { FileBadge } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { backend, type ExpiryItem } from "@/backend/client";
import { Banner } from "@/components/ui/banner";
import { Segmented } from "@/components/ui/segmented";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { EmptyState } from "@/components/EmptyState";
import type { Health } from "@/data/types";
import { resourceTab } from "@/features/resources/kinds";
import { Header, NeedsClusters, usePerCluster } from "./shared";
import { t as tt } from "@/i18n";

/** Expired or under a week: critical; under a month: warning. */
export function expiryHealth(daysLeft: number): Health {
  if (daysLeft < 7) return "failed";
  if (daysLeft < 30) return "warning";
  return "healthy";
}

function left(days: number): string {
  if (days < 0) return tt("expired {n} days ago", { n: -days });
  if (days === 0) return tt("expires today");
  return tt("{n} days left", { n: days });
}

const SOURCE_LABEL = (s: ExpiryItem["source"]) => (s === "kubeconfig" ? tt("Your kubeconfig") : s === "apiserver" ? tt("API server") : tt("TLS Secret"));

/**
 * Certificates and tokens with an end date: the kubeconfig credential, the API
 * server's certificate and every kubernetes.io/tls Secret. Secret values stay in
 * the backend; only names and dates arrive here.
 */
export function CertificatesWorkspace({ active }: { active: boolean }) {
  const ws = useWorkspace();
  const [show, setShow] = useState<"soon" | "all">("soon");
  const { clusters, data, errors, loading, refresh } = usePerCluster((c) => backend!.expiry(c), "", active, 0);
  const rows = useMemo(
    () =>
      Object.entries(data)
        .flatMap(([cluster, r]) => r.items.map((it) => ({ ...it, cluster })))
        .sort((a, b) => a.daysLeft - b.daysLeft),
    [data],
  );
  const shown = show === "soon" ? rows.filter((r) => r.daysLeft < 30) : rows;
  const expired = rows.filter((r) => r.daysLeft < 0).length;
  const soon = rows.filter((r) => r.daysLeft >= 0 && r.daysLeft < 30).length;

  const empty = NeedsClusters({ icon: <FileBadge />, title: tt("Certificates"), clusters });
  if (empty) return empty;

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-app">
      <Header
        icon={<FileBadge />}
        title={tt("Certificates")}
        sub={tt("{n} checked · {e} expired · {s} within 30 days", { n: rows.length, e: expired, s: soon })}
        onRefresh={refresh}
        loading={loading}
      >
        <Segmented
          aria-label={tt("Show")}
          value={show}
          onValueChange={setShow}
          options={[
            { value: "soon", label: tt("Expiring") },
            { value: "all", label: tt("All") },
          ]}
        />
      </Header>
      {Object.entries(errors).map(([c, e]) => (
        <Banner key={c} tone="warning" title={c} className="mx-3.5 mt-2.5">
          {e}
        </Banner>
      ))}
      {Object.values(data).flatMap((r) =>
        r.notes.map((n) => (
          <Banner key={`${r.cluster}:${n}`} tone="info" title={r.cluster} className="mx-3.5 mt-2.5">
            {n}
          </Banner>
        )),
      )}
      {shown.length === 0 ? (
        <EmptyState className="flex-1" icon={<StatusGlyph health="healthy" />} title={loading && !rows.length ? tt("Reading certificates…") : tt("Nothing expires in the next 30 days")}>
          {rows.length ? tt("{n} certificates and tokens checked.", { n: rows.length }) : undefined}
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full border-collapse text-ui">
            <thead className="sticky top-0 bg-surface-app text-left text-meta text-fg-muted">
              <tr className="border-b border-line">
                <th className="py-1.5 pl-3.5 pr-2 font-medium">{tt("Ends")}</th>
                <th className="px-2 py-1.5 font-medium">{tt("What")}</th>
                <th className="px-2 py-1.5 font-medium">{tt("Subject")}</th>
                <th className="px-2 py-1.5 font-medium">{tt("Issuer")}</th>
                <th className="py-1.5 pl-2 pr-3.5 font-medium">{tt("Cluster")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const health = expiryHealth(r.daysLeft);
                const openable = r.source === "secret" && r.name;
                return (
                  <tr key={`${r.cluster}/${r.source}/${r.namespace}/${r.name}/${r.what}`} className="border-b border-line-row align-top">
                    <td className="whitespace-nowrap py-2 pl-3.5 pr-2">
                      <span className="flex items-center gap-1.5">
                        <StatusGlyph health={health} />
                        <span className={health === "failed" ? "text-status-critical" : health === "warning" ? "text-status-warning" : ""}>{left(r.daysLeft)}</span>
                      </span>
                      <span className="pl-5 font-mono text-meta text-fg-muted">{r.notAfter.slice(0, 10)}</span>
                    </td>
                    <td className="px-2 py-2">
                      <span className="block text-fg-secondary">{SOURCE_LABEL(r.source)}</span>
                      {openable ? (
                        <button type="button" className="focus-ring font-mono text-accent hover:underline" onClick={() => ws.openView(resourceTab(r.cluster, "Secret", r.namespace ?? "", r.name!))}>
                          {r.namespace}/{r.name}
                        </button>
                      ) : (
                        <span className="font-mono">{tt(r.what)}</span>
                      )}
                    </td>
                    <td className="max-w-[320px] px-2 py-2">
                      <span className="block truncate font-mono" title={r.subject}>
                        {r.subject || "—"}
                      </span>
                      {r.dnsNames && r.dnsNames.length > 0 && (
                        <span className="block truncate font-mono text-meta text-fg-muted" title={r.dnsNames.join(", ")}>
                          {r.dnsNames.slice(0, 3).join(", ")}
                          {r.dnsNames.length > 3 ? ` +${r.dnsNames.length - 3}` : ""}
                        </span>
                      )}
                    </td>
                    <td className="max-w-[220px] truncate px-2 py-2 text-fg-secondary" title={r.issuer}>
                      {r.issuer || "—"}
                    </td>
                    <td className="whitespace-nowrap py-2 pl-2 pr-3.5">
                      <span className="flex items-center gap-1.5">
                        <EnvironmentBadge env={ws.clusterById(r.cluster)?.env ?? "dev"} />
                        {r.cluster}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
