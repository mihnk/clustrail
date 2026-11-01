import { useMemo, useState } from "react";
import { Eye, PackagePlus, Search } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { backend, errorText, type HelmChartEntry, type HelmInstallPlan, type HelmInstallRequest } from "@/backend/client";
import { useConfirm } from "@/components/safety/ConfirmationDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { EmptyState } from "@/components/EmptyState";
import { useToast } from "@/components/ui/toast";
import { useQuery } from "@/lib/useQuery";
import { cn } from "@/lib/cn";
import { t as tt } from "@/i18n";
import { CHANGE_STYLE, ObjectDiff } from "./HelmUpgradeWorkspace";

const BAR = "bg-surface-panel dark:bg-transparent";
const NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** "5m" or "90s" in seconds; NaN when not a duration. */
export function durationSeconds(text: string): number {
  const m = text.trim().match(/^(\d+)(s|m)?$/);
  return m ? Number(m[1]) * (m[2] === "s" ? 1 : 60) : NaN;
}

/** The equivalent helm command. */
export function installCommand(context: string, r: Pick<HelmInstallRequest, "namespace" | "name" | "repo" | "chart" | "version" | "createNamespace" | "wait" | "atomic">, timeout: string): string {
  return `helm --kube-context ${context} -n ${r.namespace} install ${r.name} ${r.repo}/${r.chart} --version ${r.version}${r.createNamespace ? " --create-namespace" : ""} -f values.yaml${r.wait || r.atomic ? " --wait" : ""}${r.atomic ? " --atomic" : ""} --timeout ${timeout.trim() || "5m"}`;
}

/**
 * helm install from one of this machine's repositories: pick a chart and a
 * version, write values, preview the objects with a server dry run, then
 * install as a job.
 */
export function HelmInstallWorkspace({ active }: { active: boolean }) {
  const ws = useWorkspace();
  const toast = useToast();
  const { confirm } = useConfirm();
  const targets = ws.clusters.filter((c) => c.connection === "connected");
  const [cluster, setCluster] = useState(() => ws.selectedClusters.find((c) => c.connection === "connected")?.id ?? targets[0]?.id ?? "");
  const c = ws.clusterById(cluster);
  const [query, setQuery] = useState("");
  const [chart, setChart] = useState<HelmChartEntry | null>(null);
  const [version, setVersion] = useState("");
  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState("default");
  const [createNamespace, setCreateNamespace] = useState(true);
  const [values, setValues] = useState("");
  const [wait, setWait] = useState(true);
  const [atomic, setAtomic] = useState(true);
  const [timeout, setTimeoutText] = useState("5m");
  const [plan, setPlan] = useState<HelmInstallPlan | null>(null);
  const [planFor, setPlanFor] = useState("");
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  const search = useQuery(backend && active ? `helmCharts|${query.trim()}` : null, () => backend!.helmCharts(query.trim()), { keepPrevious: true });
  const timeoutSec = durationSeconds(timeout);
  const request: HelmInstallRequest = {
    cluster, namespace: namespace.trim(), name: name.trim(), repo: chart?.repo ?? "", chart: chart?.name ?? "", version,
    values, createNamespace, wait, atomic, timeoutSec: Number.isFinite(timeoutSec) ? timeoutSec : 300,
  };
  const requestKey = JSON.stringify({ ...request, wait: 0, atomic: 0, timeoutSec: 0 });
  const stale = !!plan && planFor !== requestKey;
  const nameError = request.name && !NAME_RE.test(request.name) ? tt("Lowercase letters, digits and dashes") : null;
  const ready = !!chart && !!version && !!request.name && !nameError && !!request.namespace && !!cluster && Number.isFinite(timeoutSec);
  const listed = useMemo(() => plan?.objects ?? [], [plan]);
  const current = listed[selected] ?? listed[0];

  if (!backend) {
    return (
      <EmptyState className="flex-1" icon={<PackagePlus />} title={tt("Install a chart")}>
        {tt("Charts are installed into your clusters in the desktop app.")}
      </EmptyState>
    );
  }

  const pick = (e: HelmChartEntry) => {
    setChart(e);
    setVersion(e.version);
    if (!name || name === chart?.name) setName(e.name);
    setPlan(null);
  };
  const loadDefaults = () =>
    chart &&
    backend!
      .helmChartDefaults(chart.repo, chart.name, version)
      .then(setValues)
      .catch((e) => toast.show({ kind: "error", title: tt("Could not read the chart's defaults"), target: `${chart.repo}/${chart.name}`, detail: errorText(e), copyText: errorText(e) }));
  const preview = () => {
    setPlanning(true);
    setPlanError(null);
    backend!
      .planHelmInstall(request)
      .then((p) => {
        setPlan(p);
        setPlanFor(requestKey);
        setSelected(0);
      })
      .catch((e) => setPlanError(errorText(e)))
      .finally(() => setPlanning(false));
  };
  const command = installCommand(c?.context ?? cluster, request, timeout);
  const install = () =>
    confirm({
      action: tt("Install release"),
      targetName: request.name,
      icon: <PackagePlus />,
      env: c?.env ?? "dev",
      cluster,
      namespace: request.namespace,
      meta: `${request.repo}/${request.chart} ${request.version}`,
      protected: c?.protected ?? false,
      destructive: false,
      whatHappens: (
        <>
          {tt("{n} objects are created, as the preview showed.", { n: listed.length })}{" "}
          {atomic ? tt("If the release does not become ready within {t}, Helm removes it again.", { t: timeout }) : tt("A failed install stays as a failed release; uninstall it to retry.")}
        </>
      ),
      command,
      confirmLabel: tt("Install"),
      phrase: `${cluster}/${request.name}`,
      onConfirm: () =>
        backend!
          .installRelease(request)
          .then(() => ws.openView({ kind: "helm", title: tt("Helm releases") }))
          .catch((e) => toast.show({ kind: "error", title: tt("Install failed"), target: `${request.name} · ${cluster}`, detail: errorText(e), copyText: errorText(e) })),
    });

  const input = "focus-ring h-7 rounded-md border border-line-strong bg-surface-app px-2 font-mono text-cell text-fg";
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-app">
      <div className={cn("flex h-12 shrink-0 items-center gap-2.5 border-b border-line pl-3.5 pr-3", BAR)}>
        <PackagePlus className="size-4 text-fg-secondary" aria-hidden />
        <span className="text-title font-semibold">{tt("Install a chart")}</span>
        {c && <EnvironmentBadge env={c.env} />}
        <span className="truncate text-meta text-fg-muted">{chart ? `${chart.repo}/${chart.name} ${version}` : tt("from this machine's Helm repositories")}</span>
        <div className="flex-1" />
        <Button disabled={!ready || planning} onClick={preview}>
          <Eye aria-hidden />
          {planning ? tt("Rendering…") : tt("Preview objects")}
        </Button>
        <Button variant="danger" disabled={!plan || stale || planning || c?.readOnly} title={c?.readOnly ? tt("Read-only context") : stale ? tt("Preview the objects again first") : undefined} onClick={install}>
          {tt("Install…")}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <section aria-label={tt("Chart and values")} className="flex w-[520px] shrink-0 flex-col border-r border-line">
          <div className={cn("flex flex-col gap-2.5 border-b border-line px-3.5 py-3", BAR)}>
            <label className="flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-surface-app pl-2 pr-1.5 text-fg-muted focus-within:border-accent">
              <Search className="size-3.5 shrink-0" aria-hidden />
              <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label={tt("Search charts")} placeholder={tt("Search charts")} className="h-full min-w-0 flex-1 border-0 bg-transparent text-cell text-fg outline-none" />
            </label>
            <div role="listbox" aria-label={tt("Charts")} className="max-h-[200px] overflow-y-auto rounded-md border border-line">
              {(search.data?.charts ?? []).map((e) => (
                <button
                  key={`${e.repo}/${e.name}`}
                  type="button"
                  role="option"
                  aria-selected={chart?.repo === e.repo && chart?.name === e.name}
                  onClick={() => pick(e)}
                  className={cn("focus-ring flex w-full flex-col gap-0.5 border-b border-line-row px-2.5 py-1.5 text-left last:border-b-0", chart?.repo === e.repo && chart?.name === e.name ? "bg-surface-selected" : "hover:bg-surface-hover")}
                >
                  <span className="text-ui">
                    <span className="font-mono">
                      {e.repo}/{e.name}
                    </span>{" "}
                    <span className="text-meta text-fg-muted">
                      {e.version}
                      {e.appVersion ? ` · app ${e.appVersion}` : ""}
                      {e.deprecated ? ` · ${tt("deprecated")}` : ""}
                    </span>
                  </span>
                  {e.description && <span className="truncate text-meta text-fg-secondary">{e.description}</span>}
                </button>
              ))}
              {search.data && search.data.charts.length === 0 && <span className="block px-2.5 py-2 text-meta text-fg-muted">{search.data.note ?? tt("No chart matches.")}</span>}
            </div>
            {search.data?.note && search.data.charts.length > 0 && <span className="text-meta text-fg-muted">{search.data.note}</span>}
            <div className="grid grid-cols-2 gap-2.5">
              <label className="flex flex-col gap-[5px] text-ui text-fg-secondary">
                {tt("Cluster")}
                <select value={cluster} onChange={(e) => setCluster(e.target.value)} className={input}>
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.readOnly ? ` (${tt("read-only")})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-[5px] text-ui text-fg-secondary">
                {tt("Version")}
                <select value={version} onChange={(e) => setVersion(e.target.value)} disabled={!chart} className={input}>
                  {(chart?.versions ?? []).map((v) => (
                    <option key={v.version} value={v.version}>
                      {v.version}
                      {v.appVersion ? ` · app ${v.appVersion}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-[5px] text-ui text-fg-secondary">
                {tt("Release name")}
                <input value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!nameError} className={cn(input, nameError && "border-status-critical")} />
                {nameError && <span className="text-meta text-status-critical">{nameError}</span>}
              </label>
              <label className="flex flex-col gap-[5px] text-ui text-fg-secondary">
                {tt("Namespace")}
                <input value={namespace} onChange={(e) => setNamespace(e.target.value)} className={input} />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-ui text-fg-secondary">
              <label className="flex items-center gap-1.5">
                <Checkbox checked={createNamespace} aria-label={tt("Create the namespace (--create-namespace)")} onCheckedChange={(on) => setCreateNamespace(on === true)} />
                {tt("Create the namespace (--create-namespace)")}
              </label>
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
                <input value={timeout} onChange={(e) => setTimeoutText(e.target.value)} aria-invalid={!Number.isFinite(timeoutSec)} className={cn("focus-ring h-6 w-14 rounded border bg-surface-app px-1.5 font-mono text-cell text-fg", Number.isFinite(timeoutSec) ? "border-line-strong" : "border-status-critical")} />
              </label>
            </div>
          </div>
          <div className="flex items-center gap-2 border-b border-line px-3.5 py-1.5 text-meta text-fg-secondary">
            <span className="section-label">values.yaml</span>
            <span className="text-fg-muted">{tt("your changes only")}</span>
            <button type="button" disabled={!chart} onClick={() => void loadDefaults()} className="focus-ring ml-auto text-accent hover:underline disabled:text-fg-muted disabled:no-underline">
              {tt("Show chart defaults")}
            </button>
          </div>
          <textarea
            aria-label={tt("Values")}
            value={values}
            onChange={(e) => setValues(e.target.value)}
            spellCheck={false}
            placeholder={tt("# empty: the chart's defaults")}
            className="min-h-0 flex-1 resize-none border-0 bg-term-bg px-3.5 py-2.5 font-mono text-cell leading-[19px] text-term-fg outline-none"
          />
        </section>

        <section aria-label={tt("What is created")} className="flex min-w-0 flex-1 flex-col">
          <div className={cn("flex min-h-10 flex-wrap items-center gap-2 border-b border-line px-3.5 py-2", BAR)}>
            <span className="font-semibold">{tt("What is created")}</span>
            {plan && (
              <span className="text-meta text-fg-muted">
                {plan.chart} {plan.version} · {plan.renderedOnly ? tt("rendered only: the namespace does not exist yet, so the API server could not check the objects") : tt("server dry run")}
                {plan.hooks > 0 ? ` · ${tt("{n} hooks run", { n: plan.hooks })}` : ""}
              </span>
            )}
            {stale && <span className="text-meta text-status-warning">{tt("Changed since this preview")}</span>}
            <div className="flex-1" />
            {plan && <span className="rounded-full bg-diff-add-bg px-2 text-meta text-diff-add-fg">{tt("{n} added", { n: listed.length })}</span>}
          </div>
          {planError && <div className="selectable m-3.5 rounded-md bg-status-critical-soft px-2.5 py-2 font-mono text-meta text-status-critical">{planError}</div>}
          {!plan ? (
            <EmptyState className="flex-1" icon={<Eye />} title={tt("Preview the objects")}>
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
              </div>
              <ObjectDiff change={current} />
            </div>
          )}
          {plan?.notes && (
            <details className="mx-3.5 mt-2.5 text-meta text-fg-secondary">
              <summary className="cursor-pointer">{tt("Chart notes")}</summary>
              <pre className="selectable m-0 mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-surface-panel p-2.5 font-mono">{plan.notes}</pre>
            </details>
          )}
          <code className="selectable mx-3.5 my-2.5 block break-all rounded-md bg-surface-panel px-2.5 py-1.5 font-mono text-meta text-fg-secondary">{command}</code>
        </section>
      </div>
    </main>
  );
}
