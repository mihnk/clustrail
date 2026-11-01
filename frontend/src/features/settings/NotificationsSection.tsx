import { useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { backend, errorText, EVENTS, onEvent, type Alert, type NotifySettings } from "@/backend/client";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { t as tt } from "@/i18n";
import { Section, Setting } from "./parts";

const DOT: Record<Alert["kind"], string> = { crashloop: "bg-status-critical", oomkilled: "bg-status-critical", rollout: "bg-status-warning", recovered: "bg-status-healthy", grouped: "bg-status-warning", test: "bg-status-progressing" };

/**
 * Settings › Notifications: which namespaces to watch on which cluster, which
 * kinds of trouble to tell, a test, and what was sent lately.
 */
export function NotificationsSection({ visible }: { visible: boolean }) {
  const ws = useWorkspace();
  const toast = useToast();
  const [settings, setSettings] = useState<NotifySettings | null>(null);
  const [recent, setRecent] = useState<Alert[]>([]);
  const [adding, setAdding] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!backend) return;
    let cancelled = false;
    void backend
      .notificationSettings()
      .then((s) => !cancelled && s && setSettings({ ...s, scopes: s.scopes ?? {} }))
      .catch(() => {}); // without settings the section stays hidden
    // An alert that came as an event before this answer stays: merged by id, newest first.
    void backend.alerts().then((a) => !cancelled && setRecent((pushed) => [...pushed, ...(a ?? []).filter((x) => !pushed.some((p) => p.id === x.id))].slice(0, 50)));
    const off = onEvent<Alert>(EVENTS.alert, (a) => setRecent((r) => [a, ...r].slice(0, 50)));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  if (!visible || !backend || !settings) return null;
  const api = backend;
  const save = (next: NotifySettings) => {
    setSettings(next);
    void api.setNotificationSettings(next).catch((e) => toast.show({ kind: "error", title: tt("Notification settings not saved"), detail: errorText(e) }));
  };
  const addNamespace = (cluster: string) => {
    const ns = (adding[cluster] ?? "").trim();
    if (!ns) return;
    const cur = settings.scopes[cluster] ?? [];
    if (!cur.includes(ns)) save({ ...settings, scopes: { ...settings.scopes, [cluster]: [...cur, ns].sort() } });
    setAdding({ ...adding, [cluster]: "" });
  };
  const removeNamespace = (cluster: string, ns: string) => save({ ...settings, scopes: { ...settings.scopes, [cluster]: (settings.scopes[cluster] ?? []).filter((x) => x !== ns) } });
  const test = () =>
    void api.testNotification().then((desktop) => {
      if (!desktop) toast.show({ kind: "success", title: tt("Notifications show in the window only"), detail: tt("Desktop notifications need the packaged, signed app; this build shows them as toasts.") });
    });
  const kinds: { key: "crashLoop" | "oomKilled" | "rollout"; title: string; detail: string }[] = [
    { key: "crashLoop", title: "CrashLoopBackOff", detail: tt("A container keeps restarting: the reason and last exit code.") },
    { key: "oomKilled", title: "OOMKilled", detail: tt("A container was killed at its memory limit: the limit and how often.") },
    { key: "rollout", title: tt("Failed rollout"), detail: tt("A Deployment passed its progress deadline: the revision and what blocks it.") },
  ];

  return (
    <Section id="notifications" icon={<Bell />} title={tt("Notifications")}>
      <Setting label={tt("Desktop notifications")} detail={tt("Sent by the system while Clustrail is behind other windows; in front, the same news shows as a toast.")}>
        <Switch checked={settings.enabled} onCheckedChange={(on) => save({ ...settings, enabled: on })} aria-label={tt("Desktop notifications")} />
      </Setting>
      <div className="flex flex-col gap-2 border-t border-line-row px-3.5 py-2.5">
        <span className="section-label">{tt("Namespaces to watch")}</span>
        {ws.clusters.map((c) => {
          const nss = settings.scopes[c.id] ?? [];
          return (
            <div key={c.id} className="flex flex-wrap items-center gap-2 text-cell">
              <EnvironmentBadge env={c.env} />
              <span className="w-[150px] truncate text-fg-secondary">{c.name}</span>
              {nss.map((ns) => (
                <span key={ns} className="inline-flex h-6 items-center gap-1 rounded-full bg-surface-hover pl-2.5 pr-1 font-mono">
                  {ns}
                  <button type="button" aria-label={tt("Stop watching {ns} on {cluster}", { ns, cluster: c.name })} onClick={() => removeNamespace(c.id, ns)} className="focus-ring inline-flex size-5 items-center justify-center rounded-full hover:bg-surface-selected">
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              ))}
              <input
                aria-label={tt("Add a namespace on {cluster}", { cluster: c.name })}
                placeholder={tt("+ namespace")}
                value={adding[c.id] ?? ""}
                onChange={(e) => setAdding({ ...adding, [c.id]: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && addNamespace(c.id)}
                onBlur={() => addNamespace(c.id)}
                className="focus-ring h-6 w-[130px] rounded-full border border-dashed border-line-strong bg-transparent px-2.5 font-mono text-cell"
              />
              {nss.length === 0 && <span className="text-meta text-fg-muted">{tt("nothing picked: no notifications")}</span>}
            </div>
          );
        })}
      </div>
      <div className="flex flex-col gap-2 border-t border-line-row px-3.5 py-2.5">
        <span className="section-label">{tt("Notify when")}</span>
        {kinds.map((k) => (
          <label key={k.key} className="flex items-start gap-2.5 text-cell">
            <input type="checkbox" checked={settings[k.key]} onChange={(e) => save({ ...settings, [k.key]: e.target.checked })} className="mt-0.5 accent-[var(--color-accent)]" />
            <span className="flex flex-col">
              <span>{k.title}</span>
              <span className="text-meta text-fg-muted">{k.detail}</span>
            </span>
          </label>
        ))}
      </div>
      <Setting label={tt("Once per object until it recovers")} detail={tt("More than 5 in a minute on one cluster become one notice.")}>
        <Button size="sm" onClick={test}>
          {tt("Send a test")}
        </Button>
      </Setting>
      <div className="flex flex-col gap-1 border-t border-line-row px-3.5 py-2.5">
        <span className="section-label">{tt("Sent lately")}</span>
        {recent.length === 0 && <span className="text-meta text-fg-muted">{tt("Nothing yet.")}</span>}
        {recent.slice(0, 8).map((a) => (
          <div key={a.id} className="flex items-start gap-2 text-cell">
            <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[a.kind])} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{a.title}</span>
              <span className="truncate text-meta text-fg-muted">{[a.cluster, a.namespace, a.detail].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="ml-auto whitespace-nowrap text-meta text-fg-muted">{new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
