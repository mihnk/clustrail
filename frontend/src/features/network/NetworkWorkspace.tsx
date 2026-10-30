import { useEffect, useMemo, useState } from "react";
import { ArrowRightToLine, ArrowRightFromLine, Info, Waypoints } from "lucide-react";
import { useWorkspace, type WorkspaceTab } from "@/app/workspace";
import { backend, errorText, type ConnectionCheck, type NetPolDirection, type NetPolView } from "@/backend/client";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { EmptyState } from "@/components/EmptyState";
import { BAR, Header, NeedsClusters, useConnectedClusters } from "@/features/insights/shared";
import { cn } from "@/lib/cn";
import { t as tt } from "@/i18n";

/**
 * What NetworkPolicies let into and out of one pod, read from the objects, and
 * a check for one connection. Enforcement is the network plugin's job.
 */
export function NetworkWorkspace({ tab }: { tab: WorkspaceTab; active: boolean }) {
  const ws = useWorkspace();
  const clusters = useConnectedClusters();
  const [cluster, setCluster] = useState(tab.cluster ?? "");
  const [podText, setPodText] = useState(tab.params?.namespace && tab.params?.pod ? `${tab.params.namespace}/${tab.params.pod}` : "");
  const [view, setView] = useState<NetPolView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Opened again from another pod's menu: follow it.
  useEffect(() => {
    if (tab.params?.namespace && tab.params?.pod) {
      setPodText(`${tab.params.namespace}/${tab.params.pod}`);
      if (tab.cluster) setCluster(tab.cluster);
    }
  }, [tab.params?.namespace, tab.params?.pod, tab.cluster]);
  const target = clusters.includes(cluster) ? cluster : (clusters[0] ?? "");
  const pods = useMemo(() => ws.allPods.filter((p) => p.cluster === target).map((p) => `${p.namespace}/${p.name}`).sort(), [ws.allPods, target]);
  const [ns, pod] = podText.includes("/") ? (podText.split("/", 2) as [string, string]) : ["", ""];

  useEffect(() => {
    if (!backend || !target || !ns || !pod || !pods.includes(podText)) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    backend
      .podNetworkPolicies(target, ns, pod)
      .then((v) => !cancelled && setView(v))
      .catch((e) => !cancelled && (setView(null), setError(errorText(e))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [target, podText, pods.length > 0]);

  const empty = NeedsClusters({ icon: <Waypoints />, title: tt("Network policies"), clusters });
  if (empty) return empty;

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-app">
      <Header icon={<Waypoints />} title={tt("Network policies")} sub={view ? `${Object.entries(view.labels).map(([k, v]) => `${k}=${v}`).join(", ")} · ${target}` : undefined} />
      <div className={cn("flex shrink-0 flex-wrap items-end gap-3 border-b border-line px-3.5 py-3", BAR)}>
        {clusters.length > 1 && (
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
        )}
        <TextField label={tt("Pod (namespace/name)")} mono list="netpol-pods" value={podText} onChange={(e) => setPodText(e.target.value.trim())} className="w-[420px]" placeholder="payments/checkout-api-7d9f8b6c4-9rkzd" />
        <datalist id="netpol-pods">
          {pods.slice(0, 500).map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </div>
      {error && (
        <Banner tone="critical" className="mx-3.5 mt-2.5">
          {error}
        </Banner>
      )}
      {!view ? (
        <EmptyState className="flex-1" icon={<Waypoints />} title={loading ? tt("Reading policies…") : tt("Choose a pod")}>
          {tt("Shows which policies select it, who may connect to it and where it may connect.")}
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3">
          <div className="flex items-start gap-2 rounded-lg bg-status-progressing-soft px-3 py-2 text-meta leading-[1.45] text-fg-secondary">
            <Info className="mt-px size-3.5 shrink-0 text-status-progressing" aria-hidden />
            <span>
              {view.enforced === "yes"
                ? tt("Read from the policy objects. This cluster runs {plugin}, which enforces them.", { plugin: view.plugin })
                : view.enforced === "no"
                  ? tt("Read from the policy objects. This cluster runs {plugin}, which does not enforce them: all traffic is allowed whatever they say.", { plugin: view.plugin })
                  : tt("Read from the policy objects. Whether they are enforced depends on the network plugin, which Clustrail could not identify.")}{" "}
              {tt("Policies only add allows; a pod selected by a policy in a direction denies everything else in that direction.")}
            </span>
          </div>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(380px,1fr))]">
            <DirectionCard title={tt("Who can reach this pod")} icon={<ArrowRightToLine />} dir={view.ingress} others={tt("Everyone else")} />
            <DirectionCard title={tt("What this pod can reach")} icon={<ArrowRightFromLine />} dir={view.egress} others={tt("Everything else")} />
          </div>
          <ConnectionTester cluster={target} namespace={view.namespace} pod={view.pod} pods={pods} />
          {view.all.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="section-label">{tt("Policies in {ns}", { ns: view.namespace })}</span>
              <div className="flex flex-wrap gap-1.5">
                {view.all.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => ws.openView({ kind: "yaml", title: `YAML · ${p}`, cluster: target, params: { kind: "networking.k8s.io/NetworkPolicy", namespace: view.namespace, name: p } })}
                    className={cn(
                      "focus-ring rounded border px-1.5 py-0.5 font-mono text-meta",
                      view.ingress.policies.includes(p) || view.egress.policies.includes(p) ? "border-line-selected bg-accent-soft text-fg" : "border-line-strong text-fg-secondary",
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}

function DirectionCard({ title, icon, dir, others }: { title: string; icon: React.ReactNode; dir: NetPolDirection; others: string }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2 rounded-xl border border-line bg-surface-panel p-3.5">
      <div className="flex items-center gap-2">
        <span className="text-fg-secondary [&_svg]:size-4">{icon}</span>
        <span className="font-semibold">{title}</span>
        <span className={cn("ml-auto rounded-full px-2 text-meta", dir.isolated ? "bg-status-warning-soft text-status-warning" : "bg-status-healthy-soft text-status-healthy")}>
          {dir.isolated ? tt("isolated · {n} policies", { n: dir.policies.length }) : tt("open: no policy selects it")}
        </span>
      </div>
      {!dir.isolated && <span className="text-meta text-fg-muted">{tt("All traffic is allowed in this direction.")}</span>}
      {dir.rules.map((r) => (
        <div key={`${r.policy}/${r.rule}`} className="flex gap-2.5 rounded-lg border border-line bg-surface-app px-3 py-2">
          <StatusGlyph health="healthy" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">{r.peers}</span>
            <span className="font-mono text-meta text-fg-secondary">{r.ports}</span>
            <span className="text-meta text-fg-muted">
              {tt("{policy} · rule {n}", { policy: r.policy, n: r.rule })}
              {r.pods >= 0 ? ` · ${tt("{n} pods match now", { n: r.pods })}` : ""}
            </span>
          </span>
        </div>
      ))}
      {dir.isolated && (
        <div className="flex gap-2.5 rounded-lg border border-status-critical-soft bg-status-critical-soft px-3 py-2">
          <StatusGlyph health="failed" />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{others}</span>
            <span className="text-meta text-fg-secondary">{tt("denied: selected by {v0}", { v0: dir.policies.join(", ") })}</span>
          </span>
        </div>
      )}
    </section>
  );
}

function ConnectionTester({ cluster, namespace, pod, pods }: { cluster: string; namespace: string; pod: string; pods: string[] }) {
  const [dest, setDest] = useState("");
  const [port, setPort] = useState("");
  const [proto, setProto] = useState("TCP");
  const [result, setResult] = useState<ConnectionCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isPod = pods.includes(dest);
  const isIP = /^\d{1,3}(\.\d{1,3}){3}$/.test(dest) || (dest.includes(":") && !dest.includes("/"));
  const portNum = Number(port);
  const valid = (isPod || isIP) && Number.isInteger(portNum) && portNum > 0 && portNum < 65536;
  const run = () => {
    if (!backend || !valid) return;
    const [dns, dpod] = isPod ? (dest.split("/", 2) as [string, string]) : ["", ""];
    setError(null);
    backend
      .checkConnection(cluster, namespace, pod, dns, dpod, isPod ? "" : dest, portNum, proto)
      .then(setResult)
      .catch((e) => (setResult(null), setError(errorText(e))));
  };
  return (
    <section aria-label={tt("Test a connection")} className="flex flex-col gap-2 rounded-xl border border-line bg-surface-panel p-3.5">
      <span className="section-label">{tt("Test a connection from this pod")}</span>
      <div className="flex flex-wrap items-end gap-2">
        <TextField label={tt("To pod (namespace/name) or IP")} mono list="netpol-pods" value={dest} onChange={(e) => setDest(e.target.value.trim())} className="w-[380px]" />
        <TextField label={tt("Port")} mono inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.trim())} onKeyDown={(e) => e.key === "Enter" && run()} className="w-[90px]" />
        <label className="flex flex-col gap-[5px] text-ui text-fg-secondary">
          {tt("Protocol")}
          <select value={proto} onChange={(e) => setProto(e.target.value)} className="focus-ring h-7 rounded-md border border-line-strong bg-surface-app px-2 text-cell text-fg">
            <option>TCP</option>
            <option>UDP</option>
            <option>SCTP</option>
          </select>
        </label>
        <Button variant="primary" disabled={!valid} onClick={run}>
          {tt("Check")}
        </Button>
      </div>
      {error && <span className="selectable font-mono text-meta text-status-critical">{error}</span>}
      {result && (
        <div className="flex flex-col gap-1 text-ui">
          <span className={cn("flex items-center gap-1.5 font-semibold", result.allowed ? "text-status-healthy" : "text-status-critical")}>
            <StatusGlyph health={result.allowed ? "healthy" : "failed"} />
            {result.allowed ? tt("Allowed") : tt("Denied")}
          </span>
          <span className="text-meta text-fg-secondary">
            {tt("Leaving this pod: {v0}", { v0: result.egressVia })} · {tt("Arriving: {v0}", { v0: result.ingressVia })}
          </span>
        </div>
      )}
    </section>
  );
}
