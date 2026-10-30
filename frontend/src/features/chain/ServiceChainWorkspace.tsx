import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Route } from "lucide-react";
import { useWorkspace, type WorkspaceTab } from "@/app/workspace";
import { backend, errorText, type ChainCheck, type ServiceChain } from "@/backend/client";
import { Banner } from "@/components/ui/banner";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { EmptyState } from "@/components/EmptyState";
import { resourceTab } from "@/features/resources/kinds";
import { Header } from "@/features/insights/shared";
import type { Health } from "@/data/types";
import { cn } from "@/lib/cn";
import { t as tt } from "@/i18n";

const HEALTH: Record<ChainCheck["status"], Health> = { ok: "healthy", warning: "warning", error: "failed", info: "unknown" };

const vars = (args?: string[]) => Object.fromEntries((args ?? []).map((a, i) => [`v${i}`, a]));
/** A check's sentence and hint in the interface language. */
const label = (c: ChainCheck) => tt(c.template || c.text, vars(c.args));
const hintOf = (c: ChainCheck) => (c.hintTemplate ? tt(c.hintTemplate, vars(c.hintArgs)) : c.hint);

/** The tab that explains one Ingress or Service; opening it again focuses the same tab. */
export function chainTab(cluster: string, kind: "Ingress" | "Service", namespace: string, name: string) {
  return { kind: "chain" as const, title: tt("Chain · {name}", { name }), cluster, params: { kind, namespace, name } };
}

/**
 * Ingress → Service → Endpoints → Pods, read from the objects: no request is
 * sent to the application, so it works in read-only contexts too.
 */
export function ServiceChainWorkspace({ tab }: { tab: WorkspaceTab; active: boolean }) {
  const ws = useWorkspace();
  const cluster = tab.cluster ?? "";
  const { kind = "Service", namespace = "", name = "" } = tab.params ?? {};
  const [chain, setChain] = useState<ServiceChain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!backend || !name) return;
    setLoading(true);
    setError(null);
    backend
      .serviceChain(cluster, namespace, kind, name)
      .then(setChain)
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [cluster, namespace, kind, name]);
  useEffect(load, [load]);

  if (!backend) {
    return (
      <EmptyState className="flex-1" icon={<Route />} title={tt("Service chain")}>
        {tt("This check reads your clusters’ API servers, so it needs the desktop app.")}
      </EmptyState>
    );
  }
  if (!name) {
    return (
      <EmptyState className="flex-1" icon={<Route />} title={tt("Service chain")}>
        {tt("Open it from a Service or an Ingress: right-click a row in Services or Ingresses.")}
      </EmptyState>
    );
  }

  const open = (k: string, n: string) => ws.openView(resourceTab(cluster, k, namespace, n));
  const v = chain?.verdict;
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-app">
      <Header icon={<Route />} title={tt("Service chain")} sub={`${kind.toLowerCase()}/${name} · ${namespace} · ${cluster}`} onRefresh={load} loading={loading}>
        <span className="text-meta text-fg-muted">{tt("Read from the objects · no request is sent")}</span>
      </Header>
      {error && (
        <Banner tone="critical" className="mx-3.5 mt-2.5">
          {error}
        </Banner>
      )}
      {!chain ? (
        <EmptyState className="flex-1" title={tt("Following the chain…")} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3">
          {v && (
            <div
              role="status"
              className={cn(
                "flex flex-col gap-1 rounded-xl border px-3.5 py-3",
                v.status === "error" ? "border-status-critical bg-status-critical-soft" : v.status === "warning" ? "border-status-warning bg-status-warning-soft" : "border-line bg-status-healthy-soft",
              )}
            >
              <span className="flex items-center gap-2 font-semibold">
                <StatusGlyph health={HEALTH[v.status]} />
                {v.status === "error" ? tt("Likely cause: {v0}", { v0: label(v) }) : v.status === "warning" ? tt("Worth a look: {v0}", { v0: label(v) }) : label(v)}
              </span>
              {hintOf(v) && <span className="selectable text-meta text-fg-secondary">{hintOf(v)}</span>}
            </div>
          )}

          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
            {chain.ingress && (
              <Column kind="Ingress" title={chain.ingress.name} onOpen={() => open("networking.k8s.io/Ingress", chain.ingress!.name)} state={chain.ingress.class ? tt("class {v0}", { v0: chain.ingress.class }) : tt("no class")}>
                <Fact k={tt("Controller")}>
                  {chain.ingress.controller || "—"}
                  {chain.ingress.controllerPods >= 0 ? ` · ${tt("{n} ready", { n: chain.ingress.controllerPods })}` : ""}
                </Fact>
                {chain.ingress.routes.map((r, i) => (
                  <Fact key={i} k={i === 0 ? tt("Routes") : ""}>
                    {r.host}
                    {r.path} → {r.service ? `${r.service}:${r.port}` : r.port}
                  </Fact>
                ))}
                {chain.ingress.tls.map((t) => (
                  <Fact key={t.secret} k="TLS" tone={!t.found ? "bad" : t.daysLeft !== undefined && t.daysLeft < 14 ? "warn" : undefined}>
                    {t.secret || tt("default certificate")}
                    {t.daysLeft !== undefined ? ` · ${tt("{n} days left", { n: t.daysLeft })}` : !t.found && t.secret ? ` · ${tt("missing")}` : ""}
                  </Fact>
                ))}
                <Fact k={tt("Address")} tone={chain.ingress.address.length ? undefined : "warn"}>
                  {chain.ingress.address.join(", ") || tt("none yet")}
                </Fact>
              </Column>
            )}
            {chain.services.map((s) => (
              <ServiceColumns key={s.name} s={s} onOpen={open} />
            ))}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="section-label">{tt("Checks, in the order a request meets them")}</span>
            {chain.checks.map((c, i) => (
              <div key={i} className="flex items-baseline gap-2 text-ui">
                <span className="translate-y-0.5">
                  <StatusGlyph health={HEALTH[c.status]} />
                </span>
                <span className={cn(c.status === "info" && "text-fg-secondary")}>{label(c)}</span>
                {hintOf(c) && <span className="selectable min-w-0 truncate text-meta text-fg-muted" title={hintOf(c)}>{hintOf(c)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}

function ServiceColumns({ s, onOpen }: { s: ServiceChain["services"][number]; onOpen: (kind: string, name: string) => void }) {
  const readyPods = s.pods.filter((p) => p.ready).length;
  return (
    <>
      <Column kind="Service" title={s.name} onOpen={s.found ? () => onOpen("Service", s.name) : undefined} state={s.found ? s.type ?? "" : tt("missing")} bad={!s.found}>
        {s.found && (
          <>
            <Fact k={tt("Selector")} tone={!s.selector && !s.external ? "warn" : undefined}>
              {s.external ? `ExternalName ${s.external}` : s.selector || tt("none")}
            </Fact>
            {s.ports.map((p) => (
              <Fact key={`${p.name}/${p.port}`} k={tt("Port")}>
                {p.name ? `${p.name} ` : ""}
                {p.port} → {p.targetPort}/{p.protocol}
              </Fact>
            ))}
            {s.clusterIP && <Fact k="IP">{s.clusterIP}</Fact>}
            {s.ingresses.length > 0 && <Fact k={tt("Ingresses")}>{s.ingresses.join(", ")}</Fact>}
          </>
        )}
      </Column>
      {s.found && !s.external && (
        <>
          <Column kind={tt("Endpoints")} title={tt("{r} ready · {n} not ready", { r: s.ready.length, n: s.notReady.length })} state={s.ready.length ? tt("routable") : tt("nothing to route to")} bad={s.ready.length === 0}>
            {s.ready.length > 0 && <Fact k={tt("Ready")}>{s.ready.slice(0, 6).join(", ")}{s.ready.length > 6 ? ` +${s.ready.length - 6}` : ""}</Fact>}
            {s.notReady.length > 0 && (
              <Fact k={tt("Not ready")} tone="bad">
                {s.notReady.slice(0, 6).join(", ")}
                {s.notReady.length > 6 ? ` +${s.notReady.length - 6}` : ""}
              </Fact>
            )}
          </Column>
          <Column kind={tt("Pods")} title={tt("{n} match the selector", { n: s.pods.length })} state={tt("{r} of {n} ready", { r: readyPods, n: s.pods.length })} bad={s.pods.length > 0 && readyPods === 0}>
            {s.pods.slice(0, 8).map((p) => (
              <Fact key={p.name} k={`…${p.name.split("-").pop()}`} tone={p.ready ? undefined : p.phase === "Running" ? "warn" : "bad"} title={p.reason}>
                {p.ready ? tt("ready") : p.reason || p.phase}
              </Fact>
            ))}
            {s.pods.length > 8 && <span className="text-meta text-fg-muted">{tt("+ {n} more", { n: s.pods.length - 8 })}</span>}
          </Column>
        </>
      )}
    </>
  );
}

function Column({ kind, title, state, bad, onOpen, children }: { kind: string; title: string; state: string; bad?: boolean; onOpen?: () => void; children: ReactNode }) {
  return (
    <section aria-label={kind} className={cn("flex min-w-0 flex-col gap-2 rounded-xl border bg-surface-panel p-3", bad ? "border-status-critical" : "border-line")}>
      <div className="flex items-center gap-2">
        <span className="section-label">{kind}</span>
        <span className={cn("ml-auto truncate text-meta", bad ? "text-status-critical" : "text-fg-muted")}>{state}</span>
      </div>
      {onOpen ? (
        <button type="button" onClick={onOpen} className="focus-ring truncate text-left font-mono font-semibold text-fg hover:underline">
          {title}
        </button>
      ) : (
        <span className="truncate font-mono font-semibold">{title}</span>
      )}
      {children}
    </section>
  );
}

function Fact({ k, tone, title, children }: { k: string; tone?: "warn" | "bad"; title?: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 text-meta" title={title}>
      <span className="w-[72px] shrink-0 truncate text-fg-muted">{k}</span>
      <span className={cn("selectable min-w-0 break-words font-mono", tone === "bad" ? "text-status-critical" : tone === "warn" ? "text-status-warning" : "text-fg")}>{children}</span>
    </div>
  );
}
