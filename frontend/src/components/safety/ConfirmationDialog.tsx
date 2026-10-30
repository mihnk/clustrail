import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertDialog } from "radix-ui";
import { Check, Copy, Lock, ShieldCheck, X } from "lucide-react";
import type { Environment, Health } from "@/data/types";
import { usePersistentState } from "@/app/preferences";
import { Button, IconButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { TextField } from "@/components/ui/text-field";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { cn } from "@/lib/cn";
import { t as tt, tn } from "@/i18n";

export interface ConfirmationRequest {
  /** e.g. "Restart deployment". The target name is appended in mono. */
  action: string;
  targetName: string;
  icon: ReactNode;
  env: Environment;
  cluster: string;
  namespace?: string;
  /** Extra context after the target line, e.g. "4 replicas". */
  meta?: string;
  /** Clustrail protection of the cluster. Forces typed confirmation. */
  protected: boolean;
  destructive: boolean;
  whatHappens?: ReactNode;
  currentState?: { health: Health; text: ReactNode }[];
  /** The equivalent kubectl command, shown for standard and protected contexts. */
  command?: string;
  confirmLabel: string;
  onConfirm: () => void;
  /** Bulk actions: every target, grouped by cluster. The title replaces "<action> <target>?". */
  title?: ReactNode;
  targets?: { cluster: string; env: Environment; protected: boolean; items: { name: string; health: Health; note?: string }[] }[];
  /** Typed confirmation phrase; defaults to cluster/name. */
  phrase?: string;
}

export interface ActivityEntry {
  at: string;
  cluster: string;
  namespace?: string;
  action: string;
  target: string;
}

type Level = "light" | "standard" | "protected";

/** DEV: single confirm. STG: impact summary, Cancel is default. PROD/protected: typed confirmation. */
function levelOf(r: ConfirmationRequest): Level {
  // The strongest rule wins: one protected target makes the whole action typed.
  if (r.protected || r.env === "prod" || r.targets?.some((t) => t.protected || t.env === "prod")) return "protected";
  return r.env === "dev" ? "light" : "standard";
}

interface ConfirmContextValue {
  confirm: (request: ConfirmationRequest) => void;
  activity: ActivityEntry[];
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmationRequest | null>(null);
  const [activity, setActivity] = usePersistentState<ActivityEntry[]>("activityLog", []);

  const confirm = useCallback((r: ConfirmationRequest) => setRequest(r), []);
  const value = useMemo(() => ({ confirm, activity }), [confirm, activity]);

  const accept = () => {
    if (!request) return;
    request.onConfirm();
    // Local activity log: what was confirmed, where and when. Kept on this machine only.
    setActivity(
      [
        {
          at: new Date().toISOString(),
          cluster: request.cluster,
          namespace: request.namespace,
          action: request.action,
          target: request.targetName,
        },
        ...activity,
      ].slice(0, 500),
    );
    setRequest(null);
  };

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {request && <ConfirmationDialog request={request} onCancel={() => setRequest(null)} onAccept={accept} />}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside ConfirmationProvider");
  return ctx;
}

function ConfirmationDialog({
  request: r,
  onCancel,
  onAccept,
}: {
  request: ConfirmationRequest;
  onCancel: () => void;
  onAccept: () => void;
}) {
  const level = levelOf(r);
  const phrase = r.phrase ?? `${r.cluster}/${r.targetName}`;
  const [typed, setTyped] = useState("");
  const confirmRef = useRef<HTMLButtonElement>(null);
  const matches = level !== "protected" || typed.trim() === phrase;

  return (
    <AlertDialog.Root open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <AlertDialog.Content
          onOpenAutoFocus={(e) => {
            // Light confirmations accept with Enter; everything else defaults to Cancel.
            if (level === "light") {
              e.preventDefault();
              confirmRef.current?.focus();
            }
          }}
          className="fixed left-1/2 top-[76px] z-50 flex max-h-[calc(100vh-100px)] w-[580px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line-strong bg-surface-elevated text-fg shadow-dialog"
        >
          {level === "protected" && <div className="hatch-prod h-1 shrink-0 opacity-90" aria-hidden />}

          <div className="flex items-start gap-3.5 px-5 pt-[18px]">
            <div
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-[9px] [&_svg]:size-[18px]",
                level === "protected"
                  ? "bg-env-prod-soft text-env-prod-ink"
                  : r.destructive
                    ? "bg-status-critical-soft text-status-critical"
                    : "bg-accent-soft text-accent",
              )}
            >
              {r.icon}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <AlertDialog.Title className="m-0 text-[16px] font-semibold">
                {r.title ?? (
                  <>
                    {r.action} <span className="font-mono">{r.targetName}</span>?
                  </>
                )}
              </AlertDialog.Title>
              <AlertDialog.Description asChild className={r.targets ? "sr-only" : undefined}>
                <div className="flex flex-wrap items-center gap-2 text-cell text-fg-secondary">
                  <EnvironmentBadge env={r.env} />
                  <span className="font-mono">{r.cluster}</span>
                  {r.namespace && (
                    <>
                      <span>·</span>
                      <span>{r.namespace}</span>
                    </>
                  )}
                  {r.meta && (
                    <>
                      <span>·</span>
                      <span>{r.meta}</span>
                    </>
                  )}
                </div>
              </AlertDialog.Description>
            </div>
            <AlertDialog.Cancel asChild>
              <IconButton aria-label={tt("Close")}>
                <X />
              </IconButton>
            </AlertDialog.Cancel>
          </div>

          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">
            {r.targets && (
              <section className="flex flex-col gap-1">
                {r.targets.map((g) => (
                  <div key={g.cluster} className="flex flex-col">
                    <div className="flex items-center gap-1.5 pb-0.5 pt-1">
                      <EnvironmentBadge env={g.env} />
                      <span className="font-mono text-ui">{g.cluster}</span>
                      {g.protected && <Lock className="size-3 text-env-prod-ink" aria-label={tt("Protected")} />}
                    </div>
                    {g.items.map((t) => (
                      <div key={t.name} className="grid h-6 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-2 text-ui">
                        <StatusGlyph health={t.health} />
                        <span className="truncate font-mono">{t.name}</span>
                        {t.note && <span className="text-meta text-fg-muted">{t.note}</span>}
                      </div>
                    ))}
                  </div>
                ))}
              </section>
            )}
            {level !== "light" && r.whatHappens && (
              <section className="flex flex-col gap-2">
                <span className="section-label">{tt("What will happen")}</span>
                <p className="m-0 text-body [text-wrap:pretty]">{r.whatHappens}</p>
              </section>
            )}
            {level !== "light" && r.currentState && r.currentState.length > 0 && (
              <section className="flex flex-col gap-2">
                <span className="section-label">{tt("Current state")}</span>
                {r.currentState.map((s, i) => (
                  <div key={i} className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-x-2.5 text-body">
                    <StatusGlyph health={s.health} className="mt-[3px]" />
                    <span>{s.text}</span>
                  </div>
                ))}
              </section>
            )}
            {level !== "light" && r.command && <EquivalentCommand command={r.command} />}
            {level === "protected" && (
              <>
                <div className="flex gap-2.5 rounded-lg bg-env-prod-soft px-3 py-2.5 text-cell">
                  <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-env-prod-ink" aria-hidden />
                  <span>
                    <b className="font-semibold">{r.targets ? tt("A target is protected.") : tt("{cluster} is protected.", { cluster: r.cluster })}</b>{" "}{tt("Confirming unlocks this single action. Protected mode stays on and the action is recorded in the local activity log. Your Kubernetes permissions (RBAC) still decide whether the request succeeds.")}</span>
                </div>
                <TextField
                  size="lg"
                  mono
                  autoComplete="off"
                  label={
                    <>{tn("Type {phrase} to confirm", { phrase: <span className="font-mono font-semibold text-fg">{phrase}</span> })}</>
                  }
                  placeholder={phrase}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && matches) onAccept();
                  }}
                  trailing={matches ? <Check className="size-3.5 text-status-healthy" aria-label={tt("Matches")} /> : undefined}
                />
              </>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-line bg-surface-panel px-5 py-3">
            <span className="flex items-center gap-1.5 text-ui text-fg-muted">
              <Kbd>{tt("Esc")}</Kbd>{tt("cancel")}</span>
            <div className="flex-1" />
            <AlertDialog.Cancel asChild>
              <Button size="lg">{tt("Cancel")}</Button>
            </AlertDialog.Cancel>
            <Button
              ref={confirmRef}
              size="lg"
              variant={r.destructive || level === "protected" ? "danger" : "primary"}
              disabled={!matches}
              onClick={onAccept}
              className="disabled:opacity-50"
            >
              {r.icon}
              {r.confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function EquivalentCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="flex flex-col gap-1.5">
      <span className="section-label">{tt("Equivalent command")}</span>
      <div className="flex items-center gap-2 rounded-md border border-line bg-surface-app py-2 pl-2.5 pr-1.5">
        <code className="selectable min-w-0 flex-1 truncate font-mono text-ui text-fg-secondary" title={command}>
          {command}
        </code>
        <IconButton
          aria-label={copied ? tt("Copied") : tt("Copy command")}
          className="size-6 [&_svg]:size-3.5"
          onClick={() =>
            void navigator.clipboard?.writeText(command).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
          }
        >
          {copied ? <Check className="text-status-healthy" /> : <Copy />}
        </IconButton>
      </div>
    </section>
  );
}
