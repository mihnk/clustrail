import { useEffect, useMemo, useState } from "react";
import { ArrowUpCircle, Eye, TriangleAlert } from "lucide-react";
import { useWorkspace, type WorkspaceTab } from "@/app/workspace";
import { backend, errorText, type HelmObjectChange, type HelmUpgradePlan, type HelmUpgradeRequest, type HelmUpgradeSource } from "@/backend/client";
import { useConfirm } from "@/components/safety/ConfirmationDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { EmptyState } from "@/components/EmptyState";
import { useToast } from "@/components/ui/toast";
import { hunks, lineDiff } from "@/data/compare";
import { cn } from "@/lib/cn";
import { t as tt } from "@/i18n";

const BAR = "bg-surface-panel dark:bg-transparent";
const CHANGE_STYLE: Record<HelmObjectChange["change"], { sign: string; cls: string }> = {
  changed: { sign: "~", cls: "text-diff-chg-fg" },
  added: { sign: "+", cls: "text-diff-add-fg" },
  removed: { sign: "−", cls: "text-diff-del-fg" },
  unchanged: { sign: " ", cls: "text-fg-muted" },
};

/**
 * helm upgrade with edited values (and, when a repository has it, another
 * chart version): a server dry run shows what changes per object before
 * anything is applied.
 */
export function HelmUpgradeWorkspace({ tab }: { tab: WorkspaceTab; active: boolean }) {
  const ws = useWorkspace();
  const toast = useToast();
  const { confirm } = useConfirm();
  const cluster = tab.cluster ?? "";
  const namespace = tab.params?.namespace ?? "";
  const name = tab.params?.name ?? "";
  const c = ws.clusterById(cluster);
  const [source, setSource] = useState<HelmUpgradeSource | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState("");
  const [chart, setChart] = useState("");
  const [wait, setWait] = useState(true);
  const [atomic, setAtomic] = useState(true);
  const [timeout, setTimeoutText] = useState("5m");
  const [plan, setPlan] = useState<HelmUpgradePlan | null>(null);
  const [planFor, setPlanFor] = useState("");
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [showUnchanged, setShowUnchanged] = useState(false);

  useEffect(() => {
    if (!backend) return;
    backend
      .helmUpgradeSource(cluster, namespace, name)
      .then((s) => {
        setSource(s);
        setValues(s.values);
      })
      .catch((e) => setLoadError(errorText(e)));
  }, [cluster, namespace, name]);

  const timeoutSec = useMemo(() => {
    const m = timeout.trim().match(/^(\d+)(s|m)?$/);
    return m ? Number(m[1]) * (m[2] === "s" ? 1 : 60) : NaN;
  }, [timeout]);
  const [repo, version] = chart ? (chart.split("@") as [string, string]) : ["", ""];
  const request: HelmUpgradeRequest = { cluster, namespace, name, values, repo, version, wait, atomic, timeoutSec: Number.isFinite(timeoutSec) ? timeoutSec : 300 };
  const requestKey = JSON.stringify({ values, repo, version });
  const stale = !!plan && planFor !== requestKey;

  if (!backend) {
    return (
      <EmptyState className="flex-1" icon={<ArrowUpCircle />} title={tt("Helm upgrade")}>
        {tt("Upgrades run against your clusters in the desktop app.")}
      </EmptyState>
    );
  }
  if (loadError) return <EmptyState className="flex-1" icon={<ArrowUpCircle />} title={tt("Could not read the release")}>{loadError}</EmptyState>;
  if (!source) return <EmptyState className="flex-1" title={tt("Reading the release…")} />;

  const preview = () => {
    setPlanning(true);
    setPlanError(null);
    backend!
      .planHelmUpgrade(request)
      .then((p) => {
        setPlan(p);
        setPlanFor(requestKey);
        setSelected(0);
      })
      .catch((e) => setPlanError(errorText(e)))
      .finally(() => setPlanning(false));
  };
  const counts = { changed: 0, added: 0, removed: 0, unchanged: 0 };
  for (const o of plan?.objects ?? []) counts[o.change]++;
  const listed = (plan?.objects ?? []).filter((o) => showUnchanged || o.change !== "unchanged");
  const current = listed[selected] ?? listed[0];
  const kubectlChart = repo ? `${repo}/${source.chart} --version ${version}` : `${source.chart} --version ${source.version}`;
  const command = `helm --kube-context ${c?.context ?? cluster} -n ${namespace} upgrade ${name} ${kubectlChart} -f values.yaml${wait || atomic ? " --wait" : ""}${atomic ? " --atomic" : ""} --timeout ${timeout.trim() || "5m"}`;

  const upgrade = () =>
    confirm({
      action: tt("Upgrade release"),
      targetName: name,
      icon: <ArrowUpCircle />,
      env: c?.env ?? "dev",
      cluster,
      namespace,
      meta: `${plan?.chart} ${plan?.version}`,
      protected: c?.protected ?? false,
      destructive: counts.removed > 0,
      whatHappens: (
        <>
          {tt("{c} objects change, {a} are added and {r} removed, as the dry run showed.", { c: counts.changed, a: counts.added, r: counts.removed })}{" "}
          {atomic ? tt("If the release does not become ready within {t}, Helm rolls it back.", { t: timeout }) : tt("A failed upgrade stays failed; roll back from History.")}
        </>
      ),
      command,
      confirmLabel: tt("Upgrade"),
      phrase: `${cluster}/${name}`,
      onConfirm: () =>
        backend!
          .upgradeRelease(request)
          .then(() => ws.openView({ kind: "helm", title: tt("Helm releases") }))
          .catch((e) => toast.show({ kind: "error", title: tt("Upgrade failed"), target: `${name} · ${cluster}`, detail: errorText(e), copyText: errorText(e) })),
    });

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-app">
      <div className={cn("flex h-12 shrink-0 items-center gap-2.5 border-b border-line pl-3.5 pr-3", BAR)}>
        <ArrowUpCircle className="size-4 text-fg-secondary" aria-hidden />
        <span className="text-title font-semibold">{tt("Upgrade {name}", { name })}</span>
        {c && <EnvironmentBadge env={c.env} />}
        <span className="truncate text-meta text-fg-muted">
          {namespace} · {cluster} · {source.chart} {source.version} · {tt("revision {n}", { n: source.revision })}
        </span>
        <div className="flex-1" />
        <Button disabled={planning || !Number.isFinite(timeoutSec)} onClick={preview}>
          <Eye aria-hidden />
          {planning ? tt("Rendering…") : tt("Preview changes")}
        </Button>
        <Button variant="danger" disabled={!plan || stale || planning || c?.readOnly} title={c?.readOnly ? tt("Read-only context") : stale ? tt("Preview the changes again first") : undefined} onClick={upgrade}>
          {tt("Upgrade…")}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <section aria-label={tt("Values")} className="flex w-[520px] shrink-0 flex-col border-r border-line">
          <div className={cn("flex flex-col gap-2.5 border-b border-line px-3.5 py-3", BAR)}>
            <div className="grid grid-cols-2 gap-2.5">
              <label className="flex flex-col gap-[5px] text-ui text-fg-secondary">
                {tt("Chart")}
                <select value={chart} onChange={(e) => setChart(e.target.value)} className="focus-ring h-7 rounded-md border border-line-strong bg-surface-app px-2 font-mono text-cell text-fg">
                  <option value="">{tt("{chart} {version} (installed)", { chart: source.chart, version: source.version })}</option>
                  {source.versions.map((v) => (
                    <option key={`${v.repo}@${v.version}`} value={`${v.repo}@${v.version}`}>
                      {v.version} · {v.repo}
                      {v.appVersion ? ` · app ${v.appVersion}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col gap-[5px] text-ui text-fg-secondary">
                {tt("Start from")}
                <div className="flex gap-1.5">
                  <Button size="sm" onClick={() => setValues(source.values)}>{tt("Revision {n} values", { n: source.revision })}</Button>
                  <Button size="sm" onClick={() => setValues("{}\n")}>{tt("Chart defaults")}</Button>
                </div>
              </div>
            </div>
            {source.versionsNote && <span className="text-meta text-fg-muted">{source.versionsNote}</span>}
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-ui text-fg-secondary">
              <label className="flex items-center gap-1.5">
                <Checkbox checked={wait} aria-label={tt("Wait for resources (--wait)")} onCheckedChange={(on) => setWait(on === true)} />
                {tt("Wait for resources (--wait)")}
              </label>
              <label className="flex items-center gap-1.5">
                <Checkbox checked={atomic} aria-label={tt("Roll back on failure (--atomic)")} onCheckedChange={(on) => setAtomic(on === true)} />
                {tt("Roll back on failure (--atomic)")}
              </label>
              <label className="flex items-center gap-1.5">
                {tt("Timeout")}
                <input
                  value={timeout}
                  onChange={(e) => setTimeoutText(e.target.value)}
                  aria-invalid={!Number.isFinite(timeoutSec)}
                  className={cn("focus-ring h-6 w-14 rounded border bg-surface-app px-1.5 font-mono text-cell text-fg", Number.isFinite(timeoutSec) ? "border-line-strong" : "border-status-critical")}
                />
              </label>
            </div>
          </div>
          <div className="flex items-center gap-2 border-b border-line px-3.5 py-1.5 text-meta text-fg-secondary">
            <span className="section-label">values.yaml</span>
            <span className="text-fg-muted">{tt("[redacted by Clustrail] keeps the live value")}</span>
            {plan && !stale && plan.valueKeys.length > 0 && <span className="ml-auto text-status-warning">{tt("changed: {v0}", { v0: plan.valueKeys.join(", ") })}</span>}
          </div>
          <textarea
            aria-label={tt("Values")}
            value={values}
            onChange={(e) => setValues(e.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none border-0 bg-term-bg px-3.5 py-2.5 font-mono text-cell leading-[19px] text-term-fg outline-none"
          />
        </section>

        <section aria-label={tt("What changes")} className="flex min-w-0 flex-1 flex-col">
          <div className={cn("flex min-h-10 flex-wrap items-center gap-2 border-b border-line px-3.5 py-2", BAR)}>
            <span className="font-semibold">{tt("What changes")}</span>
            {plan && (
              <span className="text-meta text-fg-muted">
                {plan.chart} {plan.version}
                {plan.hooks > 0 ? ` · ${tt("{n} hooks run", { n: plan.hooks })}` : ""}
              </span>
            )}
            {stale && <span className="text-meta text-status-warning">{tt("Values changed since this preview")}</span>}
            <div className="flex-1" />
            {plan && (
              <>
                <span className="rounded-full bg-diff-chg-bg px-2 text-meta text-diff-chg-fg">{tt("{n} changed", { n: counts.changed })}</span>
                <span className="rounded-full bg-diff-add-bg px-2 text-meta text-diff-add-fg">{tt("{n} added", { n: counts.added })}</span>
                <span className="rounded-full bg-diff-del-bg px-2 text-meta text-diff-del-fg">{tt("{n} removed", { n: counts.removed })}</span>
                <label className="flex items-center gap-1.5 text-meta text-fg-secondary">
                  <Checkbox checked={showUnchanged} aria-label={tt("Show {n} unchanged", { n: counts.unchanged })} onCheckedChange={(on) => setShowUnchanged(on === true)} />
                  {tt("Show {n} unchanged", { n: counts.unchanged })}
                </label>
              </>
            )}
          </div>
          {planError && <div className="selectable m-3.5 rounded-md bg-status-critical-soft px-2.5 py-2 font-mono text-meta text-status-critical">{planError}</div>}
          {!plan ? (
            <EmptyState className="flex-1" icon={<Eye />} title={tt("Preview the changes")}>
              {tt("Helm renders the chart with these values and the API server validates every object (server dry run). Nothing is applied.")}
            </EmptyState>
          ) : (
            <div className="flex min-h-0 flex-1">
              <div role="listbox" aria-label={tt("Objects")} className="w-[300px] shrink-0 overflow-y-auto border-r border-line p-1.5">
                {listed.map((o, i) => (
                  <button
                    key={`${o.kind}/${o.namespace}/${o.name}`}
                    type="button"
                    role="option"
                    aria-selected={o === current}
                    onClick={() => setSelected(i)}
                    className={cn("focus-ring flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left", o === current ? "bg-surface-selected" : "hover:bg-surface-hover")}
                  >
                    <span className={cn("w-3 font-mono font-semibold", CHANGE_STYLE[o.change].cls)}>{CHANGE_STYLE[o.change].sign}</span>
                    <span className="min-w-0 truncate font-mono text-cell" title={`${o.kind}/${o.name}`}>
                      {o.kind}/{o.name}
                    </span>
                  </button>
                ))}
                {listed.length === 0 && <span className="block px-2 py-1.5 text-meta text-fg-muted">{tt("Nothing changes.")}</span>}
              </div>
              <ObjectDiff change={current} />
            </div>
          )}
          {plan && counts.removed > 0 && (
            <div className="mx-3.5 mt-2.5 flex items-start gap-2 rounded-lg bg-status-warning-soft px-3 py-2 text-meta text-fg-secondary">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-status-warning" aria-hidden />
              <span>{tt(counts.removed === 1 ? "{n} object is deleted by this upgrade: {v0}." : "{n} objects are deleted by this upgrade: {v0}.", { n: counts.removed, v0: (plan.objects ?? []).filter((o) => o.change === "removed").map((o) => `${o.kind}/${o.name}`).join(", ") })}</span>
            </div>
          )}
          <code className="selectable mx-3.5 my-2.5 block break-all rounded-md bg-surface-panel px-2.5 py-1.5 font-mono text-meta text-fg-secondary">{command}</code>
        </section>
      </div>
    </main>
  );
}

function ObjectDiff({ change }: { change: HelmObjectChange | undefined }) {
  const lines = useMemo(() => (change ? hunks(lineDiff(change.before ?? "", change.after ?? ""), change.change === "changed" ? 3 : 1000) : []), [change]);
  if (!change) return <div className="flex-1" />;
  return (
    <div className="selectable min-w-0 flex-1 overflow-auto bg-term-bg py-1.5">
      {lines.map((h, i) => (
        <div key={i} className={cn(i > 0 && "mt-1.5 border-t border-line pt-1.5")}>
          {h.map((l, j) => (
            <div
              key={j}
              className={cn(
                "whitespace-pre px-3 font-mono text-cell leading-[19px]",
                l.op === "+" ? "bg-diff-add-bg text-diff-add-fg" : l.op === "-" ? "bg-diff-del-bg text-diff-del-fg" : "text-term-fg",
              )}
            >
              {l.op} {l.text}
            </div>
          ))}
        </div>
      ))}
      {change.change === "unchanged" && <div className="px-3 font-mono text-cell text-fg-muted">{change.after}</div>}
    </div>
  );
}
