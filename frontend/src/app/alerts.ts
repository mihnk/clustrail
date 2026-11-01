import { useEffect, useEffectEvent } from "react";
import { backend, EVENTS, onEvent, type Alert } from "@/backend/client";
import { useToast } from "@/components/ui/toast";
import { useWorkspace } from "./workspace";
import { t } from "@/i18n";

/**
 * Notifications in the window: a toast for each alert while Clustrail is in
 * front (behind, the backend sends a desktop notification instead), and the
 * object opened when a desktop notification is clicked.
 */
export function useAlerts() {
  const ws = useWorkspace();
  const toast = useToast();
  const reveal = useEffectEvent((o: { kind?: unknown; cluster?: unknown; namespace?: unknown; name?: unknown }) => {
    const id = `${String(o.cluster ?? "")}/${String(o.namespace ?? "")}/${String(o.name ?? "")}`;
    if (o.kind === "Pod") {
      ws.openView({ kind: "pods", title: t("Pods") });
      ws.revealResource("pod", id);
    } else if (o.kind === "Deployment") {
      ws.openView({ kind: "deployments", title: t("Deployments") });
      ws.revealResource("deployment", id);
    }
  });
  const show = useEffectEvent((a: Alert) => {
    if (!document.hasFocus()) return;
    const where = [a.cluster, a.namespace].filter(Boolean).join(" · ");
    toast.show({
      kind: a.kind === "recovered" || a.kind === "test" ? "success" : "error",
      title: a.title,
      detail: [a.detail, where].filter(Boolean).join(" · "),
      action: a.objectKind ? { label: t("Open"), onClick: () => reveal({ kind: a.objectKind, cluster: a.cluster, namespace: a.namespace, name: a.object }) } : undefined,
    });
  });
  useEffect(() => {
    if (!backend) return;
    const offAlert = onEvent<Alert>(EVENTS.alert, (a) => show(a));
    const offReveal = onEvent<Record<string, unknown>>(EVENTS.reveal, (o) => reveal(o ?? {}));
    return () => {
      offAlert();
      offReveal();
    };
  }, []);
}
