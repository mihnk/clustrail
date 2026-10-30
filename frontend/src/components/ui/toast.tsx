import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy, X } from "lucide-react";
import type { Environment } from "@/data/types";
import { Button, IconButton } from "./button";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { t as tt } from "@/i18n";

export interface ToastInput {
  kind: "progress" | "success" | "error";
  title: ReactNode;
  /** Mono target, e.g. "ledger-sync · staging-eu-1". */
  target?: ReactNode;
  env?: Environment;
  detail?: ReactNode;
  /** 0–1 for progress toasts. */
  progress?: number;
  icon?: ReactNode;
  action?: { label: string; onClick: () => void };
  /** Text copied by the error toast's copy button. */
  copyText?: string;
  /** Progress toasts: stops the background job. */
  onCancel?: () => void;
}

interface Toast extends ToastInput {
  id: number;
}

interface ToastApi {
  /** Shows a toast and returns its id; update or dismiss it later with that id. */
  show: (t: ToastInput) => number;
  update: (id: number, t: Partial<ToastInput>) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const MAX_VISIBLE = 3;
const SUCCESS_MS = 6000;

/** Toasts and background jobs, bottom-right, at most three at a time. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const scheduleDismiss = useCallback(
    (id: number, kind: ToastInput["kind"]) => {
      if (kind === "success") setTimeout(() => dismiss(id), SUCCESS_MS);
    },
    [dismiss],
  );
  const show = useCallback(
    (t: ToastInput) => {
      const id = nextId.current++;
      setToasts((ts) => [...ts, { ...t, id }]);
      scheduleDismiss(id, t.kind);
      return id;
    },
    [scheduleDismiss],
  );
  const update = useCallback(
    (id: number, patch: Partial<ToastInput>) => {
      setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      if (patch.kind) scheduleDismiss(id, patch.kind);
    },
    [scheduleDismiss],
  );
  const api = useMemo(() => ({ show, update, dismiss }), [show, update, dismiss]);

  // Background jobs stay visible; older finished toasts give way first.
  const visible = toasts.slice(-MAX_VISIBLE);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ol
        aria-label={tt("Notifications")}
        aria-live="polite"
        className="pointer-events-none fixed bottom-8 right-3 z-50 m-0 flex w-[340px] list-none flex-col gap-2 p-0"
      >
        {visible.map((t) => (
          <li key={t.id} className="pointer-events-auto">
            <ToastCard toast={t} onDismiss={() => dismiss(t.id)} />
          </li>
        ))}
      </ol>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}

function ToastCard({ toast: t, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      role={t.kind === "error" ? "alert" : "status"}
      className="flex gap-2.5 rounded-[10px] border border-line-strong bg-surface-elevated px-3 py-2.5 text-cell text-fg shadow-menu"
    >
      <span className="mt-[3px] shrink-0 [&_svg]:size-3.5">
        {t.icon ?? <StatusGlyph health={t.kind === "error" ? "failed" : t.kind === "success" ? "completed" : "progressing"} className={t.kind === "success" ? "text-status-healthy" : undefined} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
        <span className="flex flex-wrap items-center gap-1.5">
          <b className="font-semibold">{t.title}</b>
          {t.target && <span className="truncate font-mono text-ui text-fg-secondary">{t.target}</span>}
          {t.env && <EnvironmentBadge env={t.env} size="sm" className="text-[9.5px]" />}
        </span>
        {t.kind === "progress" && t.progress !== undefined && (
          <span
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(t.progress * 100)}
            className="flex h-1 overflow-hidden rounded-sm bg-line-strong"
          >
            <i className="block h-full bg-accent" style={{ width: `${t.progress * 100}%` }} />
          </span>
        )}
        {t.detail && <span className={t.kind === "error" ? "font-mono text-meta text-fg-secondary" : "text-meta text-fg-muted"}>{t.detail}</span>}
        {t.action && (
          <button
            type="button"
            onClick={t.action.onClick}
            className="focus-ring self-start rounded-sm border-0 bg-transparent p-0 text-ui text-accent hover:text-fg"
          >
            {t.action.label}
          </button>
        )}
      </div>
      {t.kind === "progress" && t.onCancel ? (
        <Button size="sm" variant="ghost" onClick={t.onCancel}>{tt("Cancel")}</Button>
      ) : t.copyText ? (
        <IconButton
          aria-label={copied ? tt("Copied") : tt("Copy error")}
          className="size-[22px] [&_svg]:size-3"
          onClick={() =>
            void navigator.clipboard?.writeText(t.copyText!).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
          }
        >
          {copied ? <Check /> : <Copy />}
        </IconButton>
      ) : t.kind !== "progress" ? (
        <IconButton aria-label={tt("Dismiss")} className="size-[22px] [&_svg]:size-3" onClick={onDismiss}>
          <X />
        </IconButton>
      ) : null}
    </div>
  );
}
