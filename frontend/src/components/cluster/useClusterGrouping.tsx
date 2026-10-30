import { useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import type { Health } from "@/data/types";
import { isAttention } from "@/data/health";
import type { ResourceTableGrouping } from "@/components/resource-table/ResourceTable";
import { EnvMarker, EnvironmentBadge } from "@/components/status/EnvironmentBadge";

/**
 * "By cluster" view for any explorer: one section per selected cluster with
 * its environment, protection, provider summary and attention count.
 */
export function useClusterGrouping<T extends { cluster: string; health: Health }>(
  enabled: boolean,
): ResourceTableGrouping<T> | undefined {
  const { selectedClusters, clusterById } = useWorkspace();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  return useMemo(
    () =>
      enabled
        ? {
            keys: selectedClusters.map((c) => c.id),
            keyOf: (r: T) => r.cluster,
            collapsed,
            onToggle: (key: string) =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              }),
            renderHeader: (key: string, rows: T[]) => {
              const c = clusterById(key);
              const attn = rows.filter((r) => isAttention(r.health)).length;
              return (
                <>
                  {c && <EnvMarker env={c.env} />}
                  <span className="font-mono font-semibold text-fg">{key}</span>
                  {c && <EnvironmentBadge env={c.env} />}
                  {c?.protected && (
                    <span className="flex items-center gap-1.5 whitespace-nowrap text-meta text-env-prod-ink">
                      <Lock className="size-3" aria-hidden />
                      Protected
                    </span>
                  )}
                  <span className="truncate text-meta text-fg-muted">
                    {c?.connection === "connected" ? c.summary : "Not connected"}
                  </span>
                  <div className="flex-1" />
                  {attn > 0 && (
                    <span className="whitespace-nowrap text-meta text-status-critical">
                      {attn} {attn === 1 ? "needs" : "need"} attention
                    </span>
                  )}
                  <span className="font-mono text-meta text-fg-muted">{rows.length}</span>
                </>
              );
            },
          }
        : undefined,
    [enabled, selectedClusters, collapsed, clusterById],
  );
}
