import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, ExternalLink } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { backend, errorText, EVENTS, onEvent, openExternal, type PortForwardInfo, type PortForwardProfile, type PortForwardProfileState } from "@/backend/client";
import { Banner } from "@/components/ui/banner";
import { Button, IconButton } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { EmptyState } from "@/components/EmptyState";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { t as tt } from "@/i18n";
import { usePortForwards } from "./PortForward";

/** Saved profiles with their state, kept current by backend events. */
function useProfiles(): PortForwardProfileState[] {
  const [list, setList] = useState<PortForwardProfileState[]>([]);
  useEffect(() => {
    if (!backend) return;
    let cancelled = false;
    void backend.portForwardProfiles().then((l) => !cancelled && setList(l ?? []));
    const off = onEvent<PortForwardProfileState[]>(EVENTS.pfProfiles, (l) => setList(l ?? []));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return list;
}

type Tone = "healthy" | "warning" | "critical" | "neutral";
const TONE_DOT: Record<Tone, string> = { healthy: "bg-status-healthy", warning: "bg-status-warning", critical: "bg-status-critical", neutral: "bg-status-neutral" };
const TONE_TEXT: Record<Tone, string> = { healthy: "text-status-healthy", warning: "text-status-warning", critical: "text-status-critical", neutral: "text-fg-secondary" };

function stateOf(p: PortForwardProfileState): { tone: Tone; label: string; note: string; running: boolean } {
  const f = p.forward;
  if (f) {
    switch (f.state) {
      case "active":
        return { tone: "healthy", label: tt("Running"), note: f.pod ? tt("pod {pod}", { pod: f.pod }) : "", running: true };
      case "starting":
        return { tone: "warning", label: tt("Starting…"), note: "", running: true };
      case "reconnecting":
        return { tone: "warning", label: f.attempt ? tt("Reconnecting · attempt {n}", { n: f.attempt }) : tt("Reconnecting"), note: f.error ?? "", running: true };
      case "stopped":
        return { tone: "neutral", label: tt("Stopped"), note: f.error ?? "", running: false };
      case "failed":
        return { tone: "critical", label: tt("Could not start"), note: f.error ?? "", running: false };
    }
  }
  if (p.lastError) return { tone: "critical", label: tt("Could not start"), note: p.lastError, running: false };
  return { tone: "neutral", label: tt("Stopped"), note: "", running: false };
}

const blank = (cluster: string): PortForwardProfile => ({ id: "", name: "", group: "", cluster, namespace: "default", kind: "Service", target: "", port: 0, localPort: 0, reconnect: true, autoStart: false });

/**
 * Port forwards: saved profiles (start with one click, reconnect, start with
 * the cluster), the forwards running that are not saved, and the profile editor.
 */
export function PortForwardsWorkspace() {
  const ws = useWorkspace();
  const toast = useToast();
  const profiles = useProfiles();
  const forwards = usePortForwards();
  const [group, setGroup] = useState("");
  const [editing, setEditing] = useState<PortForwardProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => [...new Set(profiles.map((p) => p.group).filter((g): g is string => !!g))].sort(), [profiles]);
  const shown = group ? profiles.filter((p) => p.group === group) : profiles;
  const unsaved = forwards.filter((f) => !f.profileId);
  const running = profiles.filter((p) => stateOf(p).running).length;

  if (!backend) {
    return (
      <EmptyState className="flex-1" icon={<ArrowLeftRight />} title={tt("Port forwards")}>
        {tt("Port forwards reach your clusters, so they need the desktop app.")}
      </EmptyState>
    );
  }
  const api = backend;
  const fail = (title: string) => (e: unknown) => toast.show({ kind: "error", title, detail: errorText(e), copyText: errorText(e) });
  const start = (p: PortForwardProfileState) => void api.startPortForwardProfile(p.id).catch(fail(tt("{name} did not start", { name: p.name })));
  const stop = (p: PortForwardProfileState) => void api.stopPortForwardProfile(p.id);
  const startGroup = () => shown.filter((p) => !stateOf(p).running).forEach(start);
  const save = () => {
    if (!editing) return;
    setError(null);
    api
      .savePortForwardProfile(editing)
      .then(() => setEditing(null))
      .catch((e) => setError(errorText(e)));
  };
  const saveRunning = (f: PortForwardInfo) =>
    setEditing({ id: "", name: `${f.name} (${f.cluster})`, group: "", cluster: f.cluster, namespace: f.namespace, kind: f.kind as PortForwardProfile["kind"], target: f.name, port: f.port, localPort: f.localPort, reconnect: true });

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-app">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line bg-surface-panel pl-3.5 pr-3 dark:bg-transparent">
        <ArrowLeftRight className="size-4 text-fg-secondary" aria-hidden />
        <span className="text-title font-semibold">{tt("Port forwards")}</span>
        <span className="text-meta text-fg-muted">{tt("{running} running · {saved} saved", { running: running + unsaved.length, saved: profiles.length })}</span>
        <div className="flex-1" />
        {group && (
          <Button size="sm" onClick={startGroup}>
            {tt("Start all in “{group}”", { group })}
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => setEditing(blank(ws.selectedClusterIds[0] ?? ws.clusters[0]?.id ?? ""))}>
          {tt("New profile")}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden px-3.5 py-3">
        <section aria-label={tt("Saved profiles")} className="flex min-w-0 flex-1 flex-col gap-2.5 overflow-y-auto">
          <div className="flex items-center gap-2">
            <span className="section-label">{tt("Saved profiles")}</span>
            {groups.length > 0 && (
              <label className="ml-auto flex items-center gap-1.5 text-ui text-fg-secondary">
                {tt("Group")}
                <select value={group} onChange={(e) => setGroup(e.target.value)} className="focus-ring h-7 rounded-md border border-line-strong bg-surface-app px-2 text-cell text-fg">
                  <option value="">{tt("All profiles")}</option>
                  {groups.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {profiles.length === 0 ? (
            <span className="text-ui text-fg-muted">{tt("No profiles yet. Save a forward you use often: from the port-forward dialog, a running forward below, or New profile.")}</span>
          ) : (
            <div role="table" aria-label={tt("Profiles")} className="overflow-hidden rounded-lg border border-line">
              <div role="row" className="grid grid-cols-[18px_minmax(0,1.3fr)_minmax(0,1.6fr)_130px_130px_minmax(0,1.4fr)_auto] gap-3 bg-surface-panel px-3 py-1.5 text-meta text-fg-muted">
                <span role="columnheader" aria-label={tt("State")} />
                <span role="columnheader">{tt("Profile")}</span>
                <span role="columnheader">{tt("Target")}</span>
                <span role="columnheader">{tt("localhost → port")}</span>
                <span role="columnheader">{tt("Cluster")}</span>
                <span role="columnheader">{tt("State")}</span>
                <span role="columnheader" className="text-right">{tt("Actions")}</span>
              </div>
              {shown.map((p) => {
                const s = stateOf(p);
                const cluster = ws.clusterById(p.cluster);
                return (
                  <div key={p.id} role="row" className="grid grid-cols-[18px_minmax(0,1.3fr)_minmax(0,1.6fr)_130px_130px_minmax(0,1.4fr)_auto] items-center gap-3 border-t border-line-row px-3 py-2 text-ui">
                    <span role="cell" className={cn("size-2 rounded-full", TONE_DOT[s.tone])} />
                    <span role="cell" className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{p.name}</span>
                      {p.group && <span className="text-meta text-fg-muted">{p.group}</span>}
                    </span>
                    <span role="cell" className="truncate font-mono text-cell">
                      {p.kind.toLowerCase()}/{p.namespace}/{p.target}
                    </span>
                    <span role="cell" className="font-mono text-cell">
                      :{p.forward?.localPort || p.localPort || "auto"} → {p.port}
                    </span>
                    <span role="cell" className="flex min-w-0 items-center gap-1.5">
                      {cluster && <EnvironmentBadge env={cluster.env} />}
                      <span className="truncate text-fg-secondary">{p.cluster}</span>
                    </span>
                    <span role="cell" className="flex min-w-0 flex-col">
                      <span className={cn("font-medium", TONE_TEXT[s.tone])}>{s.label}</span>
                      {s.note && (
                        <span className="truncate text-meta text-fg-muted" title={s.note}>
                          {s.note}
                        </span>
                      )}
                    </span>
                    <span role="cell" className="flex justify-end gap-1.5">
                      {p.forward?.state === "active" && (
                        <IconButton aria-label={tt("Open in browser")} onClick={() => openExternal(`http://localhost:${p.forward!.localPort}`)}>
                          <ExternalLink />
                        </IconButton>
                      )}
                      <Button size="sm" onClick={() => (s.running ? stop(p) : start(p))}>
                        {s.running ? tt("Stop") : s.tone === "critical" ? tt("Retry") : tt("Start")}
                      </Button>
                      <Button size="sm" onClick={() => setEditing({ ...p })}>
                        {tt("Edit")}
                      </Button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <Banner tone="info">{tt("A forward to a Service or Deployment reconnects to another ready pod when its pod goes away; one to a single pod waits for that pod to come back.")}</Banner>
          {unsaved.length > 0 && (
            <>
              <span className="section-label mt-1">{tt("Running, not saved")}</span>
              {unsaved.map((f) => (
                <div key={f.id} className="flex items-center gap-3 rounded-lg border border-dashed border-line-strong px-3 py-2 text-ui">
                  <span className={cn("size-2 rounded-full", f.state === "active" ? "bg-status-healthy" : "bg-status-warning")} />
                  <span className="truncate font-mono text-cell">
                    {f.kind.toLowerCase()}/{f.namespace}/{f.name}
                  </span>
                  <span className="font-mono text-cell text-fg-secondary">
                    :{f.localPort} → {f.port}
                  </span>
                  <div className="flex-1" />
                  <Button size="sm" onClick={() => saveRunning(f)}>
                    {tt("Save as profile…")}
                  </Button>
                  <Button size="sm" onClick={() => void api.stopPortForward(f.id)}>
                    {tt("Stop")}
                  </Button>
                </div>
              ))}
            </>
          )}
        </section>
        {editing && (
          <aside aria-label={editing.id ? tt("Edit profile") : tt("New profile")} className="flex w-[360px] shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-surface-panel p-4">
            <span className="text-title font-semibold">{editing.id ? tt("Edit profile") : tt("New profile")}</span>
            <TextField label={tt("Name")} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus />
            <label className="flex flex-col gap-[5px] text-ui text-fg-secondary">
              {tt("Cluster")}
              <select value={editing.cluster} onChange={(e) => setEditing({ ...editing, cluster: e.target.value })} className="focus-ring h-7 rounded-md border border-line-strong bg-surface-app px-2 text-cell text-fg">
                {ws.clusters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2.5">
              <label className="flex flex-col gap-[5px] text-ui text-fg-secondary">
                {tt("Target")}
                <select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as PortForwardProfile["kind"] })} className="focus-ring h-7 rounded-md border border-line-strong bg-surface-app px-2 text-cell text-fg">
                  <option value="Service">Service</option>
                  <option value="Deployment">Deployment</option>
                  <option value="Pod">Pod</option>
                </select>
              </label>
              <TextField label={tt("Namespace")} mono value={editing.namespace} onChange={(e) => setEditing({ ...editing, namespace: e.target.value })} />
            </div>
            <TextField label={tt("Target name")} mono value={editing.target} onChange={(e) => setEditing({ ...editing, target: e.target.value })} />
            <div className="grid grid-cols-2 gap-2.5">
              <TextField label={tt("Port")} mono inputMode="numeric" value={editing.port ? String(editing.port) : ""} onChange={(e) => setEditing({ ...editing, port: Number(e.target.value) || 0 })} />
              <TextField label={tt("Local port")} mono inputMode="numeric" placeholder={tt("any free")} value={editing.localPort ? String(editing.localPort) : ""} onChange={(e) => setEditing({ ...editing, localPort: Number(e.target.value) || 0 })} />
            </div>
            <TextField label={tt("Group (optional)")} value={editing.group ?? ""} onChange={(e) => setEditing({ ...editing, group: e.target.value })} />
            <label className="flex items-start gap-2.5 rounded-md border border-line bg-surface-app p-2.5 text-ui">
              <input type="checkbox" checked={editing.reconnect} onChange={(e) => setEditing({ ...editing, reconnect: e.target.checked })} className="mt-0.5 accent-[var(--color-accent)]" />
              <span className="flex flex-col gap-0.5">
                {tt("Reconnect automatically")}
                <span className="text-meta text-fg-muted">{tt("When the pod goes away: another ready pod behind the Service or Deployment, retried with backoff up to 10 s apart.")}</span>
              </span>
            </label>
            <label className="flex items-start gap-2.5 rounded-md border border-line bg-surface-app p-2.5 text-ui">
              <input type="checkbox" checked={!!editing.autoStart} onChange={(e) => setEditing({ ...editing, autoStart: e.target.checked })} className="mt-0.5 accent-[var(--color-accent)]" />
              <span className="flex flex-col gap-0.5">
                {tt("Start when the cluster connects")}
                <span className="text-meta text-fg-muted">{tt("Read-only contexts never start forwards: a forwarded port reaches the application.")}</span>
              </span>
            </label>
            {error && <Banner tone="critical">{error}</Banner>}
            <div className="mt-auto flex justify-end gap-2">
              {editing.id && (
                <Button
                  onClick={() => {
                    void api.deletePortForwardProfile(editing.id);
                    setEditing(null);
                  }}
                >
                  {tt("Delete")}
                </Button>
              )}
              <Button onClick={() => setEditing(null)}>{tt("Cancel")}</Button>
              <Button variant="primary" onClick={save}>
                {tt("Save")}
              </Button>
            </div>
          </aside>
        )}
      </div>
    </main>
  );
}
