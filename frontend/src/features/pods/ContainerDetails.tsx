import { useState, type ReactNode } from "react";
import { backend, type ContainerSpecInfo, type EnvVarInfo, type PodSpecInfo, type ProbeInfo } from "@/backend/client";
import { useWorkspace } from "@/app/workspace";
import type { ContainerStatus, PodRow } from "@/data/types";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { Banner } from "@/components/ui/banner";
import { openPortForward } from "@/features/portforward/PortForward";
import { resourceTab } from "@/features/resources/kinds";
import { useQuery } from "@/lib/useQuery";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

const TYPE_LABEL: Record<ContainerSpecInfo["type"], string> = { init: "init", sidecar: "sidecar", main: "", ephemeral: "ephemeral" };

export function resourcesText(c: Pick<ContainerSpecInfo, "requests" | "limits">): string {
  const names = [...new Set([...Object.keys(c.requests), ...Object.keys(c.limits)])].sort();
  return names.map((n) => `${n} ${c.requests[n] ?? "—"} / ${c.limits[n] ?? "—"}`).join(" · ");
}

export function probeText(p: ProbeInfo): string {
  const parts = [p.action];
  if (p.initialDelay) parts.push(t("delay {s}s", { s: p.initialDelay }));
  parts.push(t("every {s}s", { s: p.period || 10 }), t("timeout {s}s", { s: p.timeout || 1 }));
  parts.push(t("{n} failures", { n: p.failureThreshold || 3 }));
  if ((p.successThreshold || 1) > 1) parts.push(t("{n} successes", { n: p.successThreshold }));
  return parts.join(" · ");
}

/** Short digest for display: "sha256:9f1c…a71e". */
export function shortDigest(imageID: string): string {
  const at = imageID.lastIndexOf("@");
  const d = at >= 0 ? imageID.slice(at + 1) : imageID;
  const m = /^(sha256:)([0-9a-f]+)$/.exec(d);
  return m && m[2]!.length > 12 ? `${m[1]}${m[2]!.slice(0, 4)}…${m[2]!.slice(-4)}` : d;
}

/**
 * The Containers tab: each container as the live pod declares it (the cache
 * drops commands, probes and literal env values), next to its status.
 */
export function ContainerDetails({ pod, statuses, active }: { pod: PodRow; statuses: ContainerStatus[]; active: boolean }) {
  const key = backend && active ? `podContainers|${pod.cluster}|${pod.namespace}|${pod.name}` : null;
  const q = useQuery<PodSpecInfo>(key, () => backend!.podContainers(pod.cluster, pod.namespace, pod.name), { keepPrevious: true });
  const info = q.data;
  const [picked, setPicked] = useState<string | null>(null);
  if (!info) {
    return q.error ? <Banner tone="warning">{q.error}</Banner> : <span className="text-ui text-fg-muted">{t("Reading the pod…")}</span>;
  }
  const sel = info.containers.find((c) => c.name === picked) ?? info.containers.find((c) => c.type === "main") ?? info.containers[0];
  const facts = [
    info.serviceAccount && t("ServiceAccount {n}", { n: info.serviceAccount }),
    info.qosClass && t("QoS {q}", { q: info.qosClass }),
    info.priorityClass && t("priority {p}", { p: info.priorityClass }),
    info.hostNetwork && t("host network"),
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-2.5">
      {facts.length > 0 && <span className="text-meta text-fg-muted">{facts.join(" · ")}</span>}
      <div role="tablist" aria-label={t("Containers")} className="flex flex-wrap gap-1.5">
        {info.containers.map((c) => {
          const st = statuses.find((s) => s.name === c.name);
          return (
            <button
              key={c.name}
              type="button"
              role="tab"
              aria-selected={c === sel}
              onClick={() => setPicked(c.name)}
              className={cn("focus-ring flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-ui", c === sel ? "border-accent bg-surface-selected text-fg" : "border-line text-fg-secondary hover:bg-surface-hover")}
            >
              {st && <StatusGlyph health={st.health} />}
              {TYPE_LABEL[c.type] && <span className="text-fg-muted">{t(TYPE_LABEL[c.type])}:</span>}
              {c.name}
            </button>
          );
        })}
      </div>
      {sel && <Container c={sel} status={statuses.find((s) => s.name === sel.name)} pod={pod} />}
      <span className="text-meta text-fg-muted">{t("Read from the live pod. Values of variables whose names look secret are hidden; references open the Secret or ConfigMap.")}</span>
    </div>
  );
}

function Container({ c, status, pod }: { c: ContainerSpecInfo; status?: ContainerStatus; pod: PodRow }) {
  const ws = useWorkspace();
  const open = (kind: string, name: string) => ws.openView(resourceTab(pod.cluster, kind, pod.namespace, name));
  const ref = (kind: string, name: string, extra?: string) => (
    <button type="button" className="focus-ring font-mono text-accent hover:underline" onClick={() => open(kind, name)}>
      {kind} {name}
      {extra}
    </button>
  );
  const label = "pt-1 text-[11px] font-semibold uppercase tracking-[.06em] text-fg-secondary";
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-line p-3">
      {status && (
        <div className="flex items-center gap-2">
          <StatusGlyph health={status.health} />
          <span className="font-mono font-semibold">{c.name}</span>
          <span className="truncate text-ui text-fg-secondary">{status.state}</span>
          <span className={cn("ml-auto font-mono text-ui", status.restarts >= 5 ? "text-status-critical" : status.restarts > 0 ? "text-status-warning" : "text-fg-muted")}>{status.restarts} ↻</span>
        </div>
      )}
      <dl className="m-0 grid grid-cols-[92px_minmax(0,1fr)] gap-x-2.5 gap-y-[5px] text-ui">
        <KV k={t("Image")} v={<Mono>{c.image}</Mono>} />
        {c.imageID && <KV k={t("Digest")} v={<Mono title={c.imageID} muted>{shortDigest(c.imageID)}</Mono>} />}
        {c.command.length > 0 && <KV k={t("Command")} v={<Mono wrap>{c.command.join(" ")}</Mono>} />}
        {c.args.length > 0 && <KV k={t("Args")} v={<Mono wrap>{c.args.join(" ")}</Mono>} />}
        {c.workingDir && <KV k={t("Working dir")} v={<Mono>{c.workingDir}</Mono>} />}
        {c.ports.length > 0 && (
          <KV
            k={t("Ports")}
            v={
              <span className="flex flex-wrap gap-x-2 font-mono text-meta">
                {c.ports.map((p) => (
                  <span key={`${p.port}/${p.protocol}`}>
                    {p.name ? `${p.name} ` : ""}
                    {p.port}/{p.protocol}
                    {p.protocol === "TCP" && c.type !== "init" && (
                      <>
                        {" · "}
                        <button type="button" className="focus-ring text-accent hover:underline" onClick={() => openPortForward({ cluster: pod.cluster, namespace: pod.namespace, kind: "Pod", name: pod.name })}>
                          {t("forward")}
                        </button>
                      </>
                    )}
                  </span>
                ))}
              </span>
            }
          />
        )}
        <KV k={t("Resources")} v={<Mono>{resourcesText(c) || t("none set")}</Mono>} />
      </dl>

      {(c.env.length > 0 || c.envFrom.length > 0) && (
        <>
          <span className={label}>{t("Environment · {n}", { n: c.env.length + c.envFrom.length })}</span>
          <dl className="m-0 grid grid-cols-[minmax(0,150px)_minmax(0,1fr)] gap-x-2.5 gap-y-1 font-mono text-meta">
            {c.env.map((e) => (
              <Row key={e.name} k={e.name} v={<EnvValue e={e} ref_={ref} />} />
            ))}
            {c.envFrom.map((f) => (
              <Row key={`${f.kind}/${f.name}`} k={f.prefix ? t("from {k} ({p}*)", { k: f.kind, p: f.prefix }) : t("from {k}", { k: f.kind })} v={<>{ref(f.kind, f.name)}<span className="text-fg-muted"> {t("all keys")}{f.optional ? `, ${t("optional")}` : ""}</span></>} />
            ))}
          </dl>
        </>
      )}

      {c.mounts.length > 0 && (
        <>
          <span className={label}>{t("Mounts · {n}", { n: c.mounts.length })}</span>
          <dl className="m-0 grid grid-cols-[minmax(0,150px)_minmax(0,1fr)] gap-x-2.5 gap-y-1 font-mono text-meta">
            {c.mounts.map((m) => (
              <Row
                key={m.path}
                k={m.path}
                title={m.path}
                v={
                  <>
                    {m.kind && m.ref ? ref(m.kind, m.ref) : <span className="text-fg-secondary">{m.source}</span>}
                    <span className="text-fg-muted">
                      {m.subPath ? ` · ${t("subPath {p}", { p: m.subPath })}` : ""}
                      {m.readOnly ? ` · ${t("read-only")}` : ""}
                    </span>
                  </>
                }
              />
            ))}
          </dl>
        </>
      )}

      <span className={label}>{t("Probes")}</span>
      {c.probes.length === 0 ? (
        <span className="text-ui text-fg-muted">{t("None: the kubelet treats the container as ready once it runs.")}</span>
      ) : (
        <dl className="m-0 grid grid-cols-[92px_minmax(0,1fr)] gap-x-2.5 gap-y-1 text-ui">
          {c.probes.map((p) => (
            <KV key={p.kind} k={t(p.kind === "liveness" ? "Liveness" : p.kind === "readiness" ? "Readiness" : "Startup")} v={<Mono wrap>{probeText(p)}</Mono>} />
          ))}
        </dl>
      )}

      {c.security.length > 0 && (
        <>
          <span className={label}>{t("Security")}</span>
          <Mono wrap>{c.security.join(" · ")}</Mono>
        </>
      )}
    </div>
  );
}

function EnvValue({ e, ref_ }: { e: EnvVarInfo; ref_: (kind: string, name: string, extra?: string) => ReactNode }) {
  if (e.hidden) return <span className="text-fg-muted">{t("•••••• (name looks secret)")}</span>;
  if (e.from === "Secret" || e.from === "ConfigMap")
    return (
      <>
        {ref_(e.from, e.ref ?? "", ` / ${e.key}`)}
        {e.optional && <span className="text-fg-muted"> {t("optional")}</span>}
      </>
    );
  if (e.from === "field") return <span className="text-fg-secondary">{t("field {f}", { f: e.ref ?? "" })}</span>;
  if (e.from === "resource") return <span className="text-fg-secondary">{t("resource {r}", { r: e.ref ?? "" })}</span>;
  return <span className="selectable break-all">{e.value === "" ? <span className="text-fg-muted">{t("(empty)")}</span> : e.value}</span>;
}

function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{k}</dt>
      <dd className="m-0 min-w-0 text-fg">{v}</dd>
    </>
  );
}

function Row({ k, v, title }: { k: string; v: ReactNode; title?: string }) {
  return (
    <>
      <dt className="truncate text-fg-secondary" title={title ?? k}>
        {k}
      </dt>
      <dd className="m-0 min-w-0">{v}</dd>
    </>
  );
}

function Mono({ children, wrap, muted, title }: { children: ReactNode; wrap?: boolean; muted?: boolean; title?: string }) {
  return (
    <span title={title} className={cn("selectable block font-mono text-meta", wrap ? "break-all" : "truncate", muted && "text-fg-secondary")}>
      {children}
    </span>
  );
}
