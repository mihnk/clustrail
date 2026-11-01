import { AlertTriangle } from "lucide-react";
import { t as tt } from "@/i18n";

/** Shown above data whose latest refresh failed: the data stays, the error is said. */
export function StaleNote({ error, updatedAt }: { error: string | null; updatedAt: number }) {
  if (!error) return null;
  const at = updatedAt ? new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  return (
    <div role="status" className="flex items-start gap-2 border-b border-line-row bg-status-warning-soft px-3.5 py-1.5 text-meta text-fg-secondary">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-status-warning" aria-hidden />
      <span className="min-w-0">
        {at ? tt("Could not refresh; showing what was read at {at}.", { at }) : tt("Could not refresh.")} <span className="text-fg-muted">{error}</span>
      </span>
    </div>
  );
}
