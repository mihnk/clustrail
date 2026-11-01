import { useEffect } from "react";
import { backend, EVENTS, onEvent } from "@/backend/client";
import { useToast } from "@/components/ui/toast";
import { readPreference } from "./preferences";

/**
 * Desktop only: sends saved settings to the Go side at startup, tells it when
 * the page is hidden (the backend's quiet mode combines that with the native
 * window state, slows probes and metrics, and pauses watches after five
 * minutes if Settings › Refresh & watch allows it), and shows the backend's
 * own notices as toasts.
 */
export function useBackendSync() {
  const toast = useToast();

  useEffect(() => {
    if (!backend) return;
    const api = backend;
    void api.setMetricsInterval(readPreference("settings.metricsIntervalSec", 15));
    void api.setUpdateMethod(readPreference<"watch" | "poll">("settings.updateMethod", "watch"));
    void api.setCacheBudget(readPreference("settings.cacheBudgetEnabled", false) ? readPreference("settings.cacheBudgetMB", 1024) : 0);
    void api.setPauseInBackground(readPreference("settings.pauseBackgroundWatches", true));

    const onVisibility = () => void api.setPageHidden(document.visibilityState === "hidden");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    const off = onEvent<{ kind: "info" | "warning"; title: string; detail?: string }>(EVENTS.notice, (n) =>
      toast.show({ kind: n.kind === "warning" ? "error" : "success", title: n.title, detail: n.detail }),
    );
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      off();
    };
  }, [toast]); // the toast API never changes: this runs once
}
