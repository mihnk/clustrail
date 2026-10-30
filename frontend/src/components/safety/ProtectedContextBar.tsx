import { Lock } from "lucide-react";
import type { Cluster } from "@/data/types";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { shortContext } from "@/lib/format";
import { t } from "@/i18n";

/**
 * Full-width band under the title bar for a workspace scoped to one protected
 * cluster. It cannot be dismissed while the tab is open.
 */
export function ProtectedContextBar({ cluster }: { cluster: Cluster }) {
  return (
    <div
      role="status"
      className="flex h-[34px] shrink-0 items-center gap-3 border-y border-env-prod bg-env-prod-soft pr-3 -mt-px"
    >
      <div className="hatch-prod w-7 self-stretch opacity-90" aria-hidden />
      <EnvironmentBadge
        env={cluster.env}
        label={cluster.env === "prod" ? "PRODUCTION" : undefined}
        className="bg-env-prod text-[#1A0E04] shadow-none"
      />
      <span className="shrink-0 whitespace-nowrap font-mono text-body font-semibold text-fg">{cluster.name}</span>
      <span className="h-4 w-px bg-env-prod opacity-50" aria-hidden />
      <span className="flex items-center gap-1.5 whitespace-nowrap text-cell font-medium text-env-prod-ink">
        <Lock className="size-3.5" aria-hidden />{t("Protected mode")}</span>
      <span className="min-w-0 truncate text-cell text-fg-secondary">{t("Changes are blocked in Clustrail until you confirm them. This is not RBAC: your kubeconfig permissions still apply.")}</span>
      <div className="flex-1" />
      <span className="hidden truncate font-mono text-meta text-fg-secondary min-[1360px]:inline" title={cluster.context}>{t("context")}{" "}{shortContext(cluster.context)}
      </span>
    </div>
  );
}
