import { useCallback, useEffect, useMemo, useState } from "react";
import { getCoreRowModel, getSortedRowModel, useReactTable, type SortingState } from "@tanstack/react-table";
import { Code, Layers, RotateCcw, Scaling, Trash2 } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { ROW_HEIGHT } from "@/app/preferences";
import { deploymentTotal } from "@/data/mock";
import type { DeploymentRow } from "@/data/types";
import { ResourceTable } from "@/components/resource-table/ResourceTable";
import { ModifyMenuButton, type ResourceAction } from "@/components/resource-actions/ResourceActions";
import { useConfirm } from "@/components/safety/ConfirmationDialog";
import { deploymentColumns } from "./columns";
import { restartDeploymentRequest } from "./requests";

/** Deployments of one namespace in one cluster (e.g. a protected production context). */
export function DeploymentsWorkspace({ cluster: clusterId, namespace }: { cluster: string; namespace: string }) {
  const { deployments, clusterById, density, restartDeployment, selectedClusterIds, reveal } = useWorkspace();
  const { confirm } = useConfirm();
  const cluster = clusterById(clusterId);
  const rows = useMemo(
    () =>
      deployments.filter(
        (d) =>
          (clusterId ? d.cluster === clusterId : selectedClusterIds.includes(d.cluster)) &&
          (!namespace || d.namespace === namespace),
      ),
    [deployments, clusterId, namespace, selectedClusterIds],
  );
  const [sorting, setSorting] = useState<SortingState>([{ id: "status", desc: false }]);
  const [selectedId, setSelectedId] = useState<string | null>(rows[0]?.id ?? null);

  const table = useReactTable({
    data: rows,
    columns: deploymentColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (d) => d.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const actionsFor = useCallback(
    (d: DeploymentRow): ResourceAction[] => [
      { id: "yaml", group: "observe", label: "View YAML", icon: <Code />, shortcut: "Y", disabled: true },
      {
        id: "restart",
        group: "modify",
        label: "Restart deployment…",
        icon: <RotateCcw />,
        shortcut: "⇧R",
        disabled: d.status === "Progressing",
        onSelect: () => confirm(restartDeploymentRequest(d, cluster, () => restartDeployment(d.id))),
      },
      { id: "scale", group: "modify", label: "Scale…", icon: <Scaling />, disabled: true },
      { id: "delete", group: "modify", label: "Delete deployment…", icon: <Trash2 />, shortcut: "⌘⌫", danger: true, disabled: true },
    ],
    [cluster, confirm, restartDeployment],
  );

  const rowActions = useCallback(
    (id: string) => {
      const d = rows.find((r) => r.id === id);
      return d && cluster ? { actions: actionsFor(d), target: { env: d.env, protected: cluster.protected } } : null;
    },
    [rows, cluster, actionsFor],
  );

  const selected = rows.find((r) => r.id === selectedId) ?? null;

  useEffect(() => {
    if (reveal?.kind === "deployment" && rows.some((r) => r.id === reveal.id)) setSelectedId(reveal.id);
  }, [reveal?.seq]);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-app">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line bg-surface-panel px-4 dark:bg-transparent">
        <Layers className="size-4" aria-hidden />
        <span className="text-title font-semibold">Deployments</span>
        <span className="text-cell text-fg-muted">
          {namespace} · {rows.length} of {deploymentTotal}
        </span>
        <div className="flex-1" />
        {cluster && selected && (
          <ModifyMenuButton
            actions={actionsFor(selected)}
            target={{ env: selected.env, protected: cluster.protected }}
            cluster={cluster.name}
          />
        )}
      </div>
      <ResourceTable
        table={table}
        aria-label={`Deployments in ${namespace} on ${clusterId}`}
        rowHeight={ROW_HEIGHT[density]}
        selectedId={selectedId}
        onSelect={setSelectedId}
        rowActions={rowActions}
        columnGap={10}
        paddingX={16}
      />
    </main>
  );
}
