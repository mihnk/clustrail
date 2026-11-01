import { useEffect, useEffectEvent, useState } from "react";
import { Dialog } from "radix-ui";
import { AlertTriangle, Check, X } from "lucide-react";
import { backend, errorText, type CrashReport } from "@/backend/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useWorkspace } from "./workspace";
import { t } from "@/i18n";

// Local crash and freeze reports (issue D7, designed on the canvas's
// "Crash and freeze reports" board). Nothing is sent anywhere.

const HOLDS = () => [
  [t("Where it stopped"), t("the Go stack of the failing goroutine, or what the window was showing.")],
  [t("Versions"), t("Clustrail, the operating system, Go and the Kubernetes client.")],
  [t("The last 200 lines of Clustrail’s own log"), t("with cluster names and addresses replaced.")],
] as const;

/** At start: the crash or panic from last time, offered once. */
export function CrashOffer() {
  const [report, setReport] = useState<CrashReport | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!backend) return;
    let cancelled = false;
    void backend
      .pendingCrash()
      .then((r) => !cancelled && setReport(r ?? null))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  if (!backend || !report) return null;
  const api = backend;
  const close = () => {
    void api.ackCrash(report.id).catch(() => {});
    setReport(null);
  };
  const when = new Date(report.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  return (
    <Dialog.Root open onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[72px] z-50 flex w-[600px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line-strong bg-surface-elevated text-fg shadow-dialog"
        >
          <div className="flex gap-3.5 px-5 pb-3 pt-4">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-status-warning-soft text-status-warning">
              <AlertTriangle className="size-[18px]" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <Dialog.Title className="m-0 text-[16px] font-semibold">
                {report.kind === "crash" ? t("Clustrail stopped unexpectedly last time") : t("Clustrail recovered from an internal error last time")}
              </Dialog.Title>
              <span className="text-cell text-fg-secondary">
                {t("{when} · {what}. A report was written on this computer; nothing was sent anywhere.", { when, what: report.detail || report.title })}
              </span>
            </span>
          </div>
          <div className="flex flex-col gap-2 px-5 pb-3">
            <span className="section-label">{t("What the report holds")}</span>
            {HOLDS().map(([title, detail]) => (
              <span key={title} className="flex items-baseline gap-2.5 text-cell">
                <Check className="size-3.5 shrink-0 text-status-healthy" aria-hidden />
                <span>
                  <span className="font-medium">{title}</span> <span className="text-fg-secondary">— {detail}</span>
                </span>
              </span>
            ))}
            <span className="flex items-baseline gap-2.5 text-cell">
              <X className="size-3.5 shrink-0 text-status-critical" aria-hidden />
              <span>
                <span className="font-medium">{t("No cluster data")}</span>{" "}
                <span className="text-fg-secondary">— {t("no object names, namespaces, server addresses, tokens or log lines from pods.")}</span>
              </span>
            </span>
          </div>
          <details className="mx-5 mb-3.5 rounded-lg border border-line bg-surface-app">
            <summary className="cursor-pointer px-3 py-2 text-cell text-fg-secondary">{t("Show the report")}</summary>
            <pre className="selectable m-0 max-h-[220px] overflow-auto whitespace-pre-wrap border-t border-line px-3 py-2.5 font-mono text-meta leading-normal text-fg-secondary">{report.text}</pre>
          </details>
          <div className="flex items-center gap-2 border-t border-line px-5 py-3">
            <span className="flex-1 text-meta text-fg-muted">{t("Kept in Settings › Privacy & diagnostics until you delete it.")}</span>
            <Button onClick={() => void api.revealCrashReport(report.id).catch((e) => window.alert(errorText(e)))}>{t("Show the file")}</Button>
            <Button
              onClick={() =>
                void navigator.clipboard?.writeText(report.text).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? t("Copied") : t("Copy report")}
            </Button>
            <Button variant="primary" onClick={close}>
              {t("Continue")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** How far behind a timer may run before the window counts as frozen. */
const FREEZE_MS = 1000;
const TICK_MS = 250;

/**
 * Notices the window stopping answering: a timer that should fire every
 * 250 ms and came more than a second late. Only while the window is visible
 * (hidden windows slow their timers on purpose). Reports go to the backend,
 * which keeps at most one a minute.
 */
export function useFreezeWatch() {
  const toast = useToast();
  const ws = useWorkspace();
  const report = useEffectEvent((ms: number) => {
    if (!backend) return;
    const where = [ws.activeTab?.title, `${document.querySelectorAll("[role=row]").length} rows in view`].filter(Boolean).join(" · ");
    void backend
      .reportFreeze(ms, where)
      .then((r) => {
        if (!r?.id) return;
        toast.show({
          kind: "error",
          title: t("The window froze for {s} s", { s: (ms / 1000).toFixed(1) }),
          detail: t("A report was saved: what the window was showing when it stopped answering."),
          action: { label: t("Show the report"), onClick: () => ws.openView({ kind: "settings", title: t("Settings"), params: { section: "privacy" } }) },
        });
      })
      .catch(() => {});
  });
  useEffect(() => {
    if (!backend || new URLSearchParams(location.search).has("bench")) return;
    let last = performance.now();
    let visible = document.visibilityState === "visible";
    const timer = window.setInterval(() => {
      const now = performance.now();
      const late = now - last - TICK_MS;
      const stillVisible = document.visibilityState === "visible";
      if (late > FREEZE_MS && visible && stillVisible) report(Math.round(late + TICK_MS));
      last = now;
      visible = stillVisible;
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
}
