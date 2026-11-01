import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { WorkspaceTab } from "@/app/workspace";
import { backend, errorText, type WhoCanGrant, type WhoCanRequest, type WhoCanResult } from "@/backend/client";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/cn";
import { BAR, Header, NeedsClusters, useConnectedClusters } from "./shared";
import { t as tt } from "@/i18n";

const VERBS: WhoCanRequest["verb"][] = ["get", "list", "watch", "create", "update", "patch", "delete", "exec"];
const KINDS = ["Secret", "ConfigMap", "Pod", "apps/Deployment", "apps/StatefulSet", "apps/DaemonSet", "Service", "Node", "Namespace", "PersistentVolumeClaim", "rbac.authorization.k8s.io/ClusterRole"];

/**
 * Who can? Every subject whose RBAC rules allow a verb on an object, with the
 * binding and rule that grant it. Opened from a resource's menu with the
 * question filled in, or empty from the palette.
 */
export function WhoCanWorkspace({ tab, active: _active }: { tab: WorkspaceTab; active: boolean }) {
  const clusters = useConnectedClusters();
  const p = tab.params ?? {};
  const [cluster, setCluster] = useState(tab.cluster ?? "");
  const [verb, setVerb] = useState<WhoCanRequest["verb"]>((p.verb as WhoCanRequest["verb"]) || "get");
  const [kind, setKind] = useState(p.kind || "Secret");
  const [namespace, setNamespace] = useState(p.namespace ?? "default");
  const [name, setName] = useState(p.name ?? "");
  const [result, setResult] = useState<WhoCanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const target = clusters.includes(cluster) ? cluster : (clusters[0] ?? "");

  const ask = (req: WhoCanRequest) => {
    if (!backend || !req.cluster) return;
    setBusy(true);
    setError(null);
    backend
      .whoCan(req)
      .then((r) => {
        setResult(r);
        setSelected(r.grants.length ? 0 : null);
      })
      .catch((e) => {
        setResult(null);
        setError(errorText(e));
      })
      .finally(() => setBusy(false));
  };

  // Opened again from another object's menu: take its question and ask it.
  const opened = `${tab.cluster ?? ""}|${p.verb ?? ""}|${p.kind ?? ""}|${p.namespace ?? ""}|${p.name ?? ""}`;
  useEffect(() => {
    if (!p.kind) return;
    const req: WhoCanRequest = { cluster: tab.cluster ?? "", verb: (p.verb as WhoCanRequest["verb"]) || "get", kind: p.kind, namespace: p.namespace ?? "", name: p.name ?? "" };
    setCluster(req.cluster);
    setVerb(req.verb);
    setKind(req.kind);
    setNamespace(req.namespace);
    setName(req.name);
    ask(req);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opened names the question; asking reads it from there
  }, [opened]);

  const empty = NeedsClusters({ icon: <ShieldCheck />, title: tt("Who can?"), clusters });
  if (empty) return empty;

  const submit = () => ask({ cluster: target, verb, kind, namespace: namespace.trim(), name: name.trim() });
  const grant = selected !== null ? result?.grants[selected] : undefined;
  const wideCount = result?.grants.filter((g) => g.scope === "cluster-wide").length ?? 0;
  const subjectCount = new Set(result?.grants.map((g) => `${g.subjectKind}/${g.subject}`)).size;

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-app">
      <Header icon={<ShieldCheck />} title={tt("Who can?")} sub={target} />
      <form
        aria-label={tt("Question")}
        className={cn("flex shrink-0 flex-wrap items-end gap-3 border-b border-line px-3.5 py-3", BAR)}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-[5px] text-ui text-fg-secondary">
          {tt("Cluster")}
          <select value={target} onChange={(e) => setCluster(e.target.value)} className="focus-ring h-7 rounded-md border border-line-strong bg-surface-app px-2 text-cell text-fg">
            {clusters.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-[5px] text-ui text-fg-secondary">
          {tt("Who can")}
          <select value={verb} onChange={(e) => setVerb(e.target.value as WhoCanRequest["verb"])} className="focus-ring h-7 rounded-md border border-line-strong bg-surface-app px-2 font-mono text-cell text-fg">
            {VERBS.map((v) => (
              <option key={v} value={v}>
                {v === "exec" ? tt("exec into") : v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-[5px] text-ui text-fg-secondary">
          {tt("Kind")}
          <input list="whocan-kinds" value={kind} onChange={(e) => setKind(e.target.value)} className="focus-ring h-7 w-[200px] rounded-md border border-line-strong bg-surface-app px-2 font-mono text-cell text-fg" />
          <datalist id="whocan-kinds">
            {KINDS.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        </label>
        <TextField label={tt("Namespace")} mono value={namespace} onChange={(e) => setNamespace(e.target.value)} className="w-[160px]" />
        <TextField label={tt("Name (optional)")} mono value={name} onChange={(e) => setName(e.target.value)} className="w-[220px]" />
        <Button type="submit" variant="primary" disabled={busy || !kind.trim()}>
          {busy ? tt("Asking…") : tt("Ask")}
        </Button>
      </form>
      {error && (
        <Banner tone="critical" className="mx-3.5 mt-2.5">
          {error}
        </Banner>
      )}
      {!result ? (
        <EmptyState className="flex-1" icon={<ShieldCheck />} title={tt("Who may do something to an object?")}>
          {tt("Read from Roles, ClusterRoles and their bindings: every subject a rule allows, and the binding and rule that grant it. Needs permission to list the four RBAC kinds.")}
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 gap-4 overflow-hidden px-3.5 py-3">
          <section aria-label={tt("Answer")} className="flex min-w-0 flex-1 flex-col gap-2.5 overflow-y-auto">
            <div className="flex flex-wrap items-baseline gap-2.5">
              <span className="text-[17px] font-semibold">
                {tt("{n} subjects can {verb} {object}", {
                  n: subjectCount,
                  verb: result.request.verb === "exec" ? tt("exec into") : result.request.verb,
                  object: result.request.name ? `${result.request.kind} ${result.request.name}` : result.request.kind,
                })}
              </span>
              {wideCount > 0 && <span className="text-ui text-fg-secondary">{tt("{n} through cluster-wide bindings", { n: wideCount })}</span>}
            </div>
            <Banner tone="info">{tt("From Roles, ClusterRoles and their bindings. Webhook authorizers, impersonation and the cloud provider's own IAM are not seen here.")}</Banner>
            {result.missing.length > 0 && (
              <Banner tone="warning">{tt("Incomplete: these could not be listed with your access: {kinds}.", { kinds: result.missing.join(", ") })}</Banner>
            )}
            {result.grants.length === 0 ? (
              <span className="text-ui text-fg-muted">{tt("No binding grants this. system:masters can still do it: that group bypasses RBAC.")}</span>
            ) : (
              <div role="table" aria-label={tt("Subjects")} className="overflow-hidden rounded-lg border border-line">
                <div role="row" className="grid grid-cols-[110px_minmax(0,1.4fr)_120px_minmax(0,2fr)] gap-3 bg-surface-panel px-3 py-1.5 text-meta text-fg-muted">
                  <span role="columnheader">{tt("Kind")}</span>
                  <span role="columnheader">{tt("Subject")}</span>
                  <span role="columnheader">{tt("Scope")}</span>
                  <span role="columnheader">{tt("Granted by")}</span>
                </div>
                {result.grants.map((g, i) => (
                  <button
                    key={`${g.subjectKind}/${g.subject}/${g.binding}`}
                    type="button"
                    role="row"
                    aria-selected={i === selected}
                    onClick={() => setSelected(i)}
                    className={cn(
                      "focus-ring grid w-full grid-cols-[110px_minmax(0,1.4fr)_120px_minmax(0,2fr)] items-start gap-3 border-t border-line-row px-3 py-2 text-left text-ui",
                      g.wide && "bg-status-warning-soft/40",
                      i === selected && "bg-surface-selected",
                    )}
                  >
                    <span role="cell">
                      <span className="rounded-full bg-surface-hover px-2 py-0.5 text-meta">{g.subjectKind}</span>
                    </span>
                    <span role="cell" className="flex min-w-0 flex-col gap-0.5">
                      <span className="selectable truncate font-mono text-cell">{g.subject}</span>
                      <GrantNote g={g} />
                    </span>
                    <span role="cell" className={cn(g.scope === "cluster-wide" ? "text-status-warning" : "text-fg-secondary")}>
                      {g.scope === "cluster-wide" ? tt("cluster-wide") : g.scope}
                    </span>
                    <span role="cell" className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-mono text-cell">
                        {g.binding} → {g.role}
                      </span>
                      <span className="truncate font-mono text-meta text-fg-muted">{g.rule}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
          {grant && (
            <aside aria-label={tt("Selected subject")} className="flex w-[360px] shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-surface-panel p-4">
              <span className="section-label">{grant.subjectKind}</span>
              <span className="selectable font-mono text-ui">{grant.subject}</span>
              <GrantNote g={grant} />
              <div className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-app p-2.5 text-ui">
                <span className="text-meta text-fg-secondary">{grant.binding.split(" ")[0]}</span>
                <span className="selectable font-mono text-cell">{grant.binding.split(" ").slice(1).join(" ")}</span>
                <span className="mt-1.5 text-meta text-fg-secondary">{grant.role.split(" ")[0]}</span>
                <span className="selectable font-mono text-cell">{grant.role.split(" ").slice(1).join(" ")}</span>
                <pre className="selectable m-0 mt-1.5 whitespace-pre-wrap font-mono text-meta text-fg">{grant.ruleYAML}</pre>
              </div>
              {grant.subjectKind === "ServiceAccount" && (
                <>
                  <span className="section-label mt-1">{tt("Pods that run as it")}</span>
                  <span className="selectable font-mono text-cell text-fg-secondary">
                    {(result.serviceAccountPods[grant.subject] ?? []).join(", ") || tt("none in the cache")}
                  </span>
                </>
              )}
            </aside>
          )}
        </div>
      )}
    </main>
  );
}

function GrantNote({ g }: { g: WhoCanGrant }) {
  if (g.onlyNames?.length) return <span className="text-meta text-fg-muted">{tt("only {names}", { names: g.onlyNames.join(", ") })}</span>;
  if (g.scope === "cluster-wide") return <span className="text-meta text-status-warning">{tt("in every namespace")}</span>;
  if (g.wide) return <span className="text-meta text-status-warning">{tt("through a wildcard rule")}</span>;
  return null;
}
