import { useEffect, useState } from "react";
import { Check, Minus, ShieldCheck, X } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { backend, errorText, type AccessResult, type AccessSubject } from "@/backend/client";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { TextField } from "@/components/ui/text-field";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/cn";
import { BAR, Header, NeedsClusters, useConnectedClusters } from "./shared";
import { t as tt } from "@/i18n";

type Kind = "me" | "User" | "Group" | "ServiceAccount";

/**
 * What an identity may do in a namespace: a matrix of SubjectAccessReviews
 * (yours with SelfSubjectAccessReviews), and the bindings that name it.
 */
export function AccessWorkspace({ active: _active }: { active: boolean }) {
  const ws = useWorkspace();
  const clusters = useConnectedClusters();
  const [cluster, setCluster] = useState("");
  const [kind, setKind] = useState<Kind>("me");
  const [name, setName] = useState("");
  const [saNamespace, setSaNamespace] = useState("");
  const [namespace, setNamespace] = useState("");
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [result, setResult] = useState<AccessResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const target = clusters.includes(cluster) ? cluster : (clusters[0] ?? "");
  useEffect(() => {
    if (!backend || !target) return;
    let cancelled = false;
    void backend
      .namespaces(target)
      .then((ns) => {
        if (cancelled) return;
        setNamespaces(ns);
        const c = ws.clusterById(target);
        setNamespace((cur) => (cur && ns.includes(cur) ? cur : c?.namespace && ns.includes(c.namespace) ? c.namespace : ns.includes("default") ? "default" : (ns[0] ?? "")));
      })
      .catch(() => setNamespaces([]));
    return () => {
      cancelled = true;
    };
  }, [target]);

  const empty = NeedsClusters({ icon: <ShieldCheck />, title: tt("Access"), clusters });
  if (empty) return empty;

  const valid = kind === "me" || (name.trim() !== "" && (kind !== "ServiceAccount" || saNamespace.trim() !== ""));
  const check = () => {
    if (!backend || !valid) return;
    const subject: AccessSubject = kind === "me" ? { kind: "", name: "" } : { kind, name: name.trim(), namespace: kind === "ServiceAccount" ? saNamespace.trim() : undefined };
    setBusy(true);
    setError(null);
    backend
      .accessMatrix(target, subject, namespace)
      .then((r) => setResult(r))
      .catch((e) => {
        setResult(null);
        setError(errorText(e));
      })
      .finally(() => setBusy(false));
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-app">
      <Header icon={<ShieldCheck />} title={tt("Access")} sub={tt("What an identity may do, as the API server decides it")} />
      <div className={cn("flex shrink-0 flex-wrap items-end gap-3 border-b border-line px-3.5 py-3", BAR)}>
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
        <div className="flex flex-col gap-[5px] text-ui text-fg-secondary">
          {tt("Who")}
          <Segmented
            aria-label={tt("Who")}
            value={kind}
            onValueChange={setKind}
            options={[
              { value: "me", label: tt("Me") },
              { value: "User", label: tt("User") },
              { value: "Group", label: tt("Group") },
              { value: "ServiceAccount", label: tt("ServiceAccount") },
            ]}
          />
        </div>
        {kind !== "me" && <TextField label={tt("Name")} mono value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && check()} className="w-[220px]" />}
        {kind === "ServiceAccount" && <TextField label={tt("Its namespace")} mono value={saNamespace} onChange={(e) => setSaNamespace(e.target.value)} className="w-[160px]" />}
        <label className="flex flex-col gap-[5px] text-ui text-fg-secondary">
          {tt("In namespace")}
          <select value={namespace} onChange={(e) => setNamespace(e.target.value)} className="focus-ring h-7 rounded-md border border-line-strong bg-surface-app px-2 font-mono text-cell text-fg">
            {!namespaces.includes(namespace) && <option value={namespace}>{namespace || "default"}</option>}
            {namespaces.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <Button variant="primary" disabled={!valid || busy} onClick={check}>
          {busy ? tt("Checking…") : tt("Check access")}
        </Button>
      </div>
      {kind === "User" && (
        <span className="px-3.5 pt-2 text-meta text-fg-muted">{tt("A User is checked on its own: its groups are not known to Clustrail. Check a Group too when access comes through one.")}</span>
      )}
      {error && (
        <Banner tone="critical" className="mx-3.5 mt-2.5">
          {error}
        </Banner>
      )}
      {!result ? (
        <EmptyState className="flex-1" icon={<ShieldCheck />} title={tt("Check what an identity may do")}>
          {tt("Each cell is one access review against the API server, so the answer includes every Role, ClusterRole and webhook. Checking someone else needs permission to create subjectaccessreviews.")}
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui">
            <span className="text-fg-muted">{tt("Identity")}</span>
            <span className="selectable font-mono font-semibold">{result.user || (result.subject.kind === "Group" ? `group:${result.subject.name}` : "—")}</span>
            {result.groups.length > 0 && (
              <span className="selectable truncate font-mono text-meta text-fg-secondary" title={result.groups.join(", ")}>
                {result.groups.join(", ")}
              </span>
            )}
            <span className="text-fg-muted">
              · {tt("namespace")} <span className="font-mono text-fg">{result.namespace || "default"}</span> · {target}
            </span>
          </div>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full border-collapse text-ui">
              <thead className="bg-surface-panel text-meta text-fg-muted">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">{tt("Resource")}</th>
                  {result.verbs.map((v) => (
                    <th key={v} className="px-2 py-1.5 text-center font-mono font-medium">
                      {v}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.resources.map((r, i) => (
                  <tr key={r.label} className="border-t border-line-row">
                    <td className="whitespace-nowrap px-3 py-1 font-mono">
                      {r.label}
                      {!r.namespaced && <span className="pl-1.5 font-sans text-meta text-fg-muted">{tt("cluster")}</span>}
                    </td>
                    {result.allowed[i]!.map((a, j) => (
                      <td key={j} className="px-2 py-1 text-center">
                        <Cell value={a} label={`${result.verbs[j]} ${r.label}`} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-1">
            <span className="section-label">{tt("Bindings that name this identity")}</span>
            {result.bindings.length === 0 && <span className="text-meta text-fg-muted">{tt("None found. Access may come from the system:authenticated group, an aggregated role or a webhook.")}</span>}
            {result.bindings.map((b) => (
              <div key={`${b.kind}/${b.namespace}/${b.name}`} className="flex items-center gap-2 text-ui">
                <span className="w-[140px] shrink-0 text-fg-muted">{b.kind}</span>
                <span className="selectable font-mono">
                  {b.namespace ? `${b.namespace}/` : ""}
                  {b.name}
                </span>
                <span className="text-fg-muted">→</span>
                <span className="font-mono">{b.role}</span>
                <span className="text-meta text-fg-muted">{tt("via {v0}", { v0: b.via })}</span>
              </div>
            ))}
            {result.bindingsNote && <span className="text-meta text-status-warning">{result.bindingsNote}</span>}
          </div>
        </div>
      )}
    </main>
  );
}

function Cell({ value, label }: { value: AccessResult["allowed"][number][number]; label: string }) {
  switch (value) {
    case "yes":
      return <Check className="mx-auto size-3.5 text-status-healthy" aria-label={tt("{v0}: allowed", { v0: label })} />;
    case "no":
      return <X className="mx-auto size-3.5 text-status-critical" aria-label={tt("{v0}: denied", { v0: label })} />;
    case "error":
      return <span className="text-meta text-status-warning" title={tt("The review failed")}>?</span>;
    default:
      return <Minus className="mx-auto size-3 text-fg-muted opacity-50" aria-label={tt("{v0}: not applicable", { v0: label })} />;
  }
}
