import { useEffect, useRef } from "react";
import { backend, EVENTS, onEvent } from "@/backend/client";
import { useToast } from "@/components/ui/toast";
import { readPreference } from "./preferences";

const BACKGROUND_PAUSE_MS = 5 * 60_000;

/**
 * Desktop only: sends saved settings to the Go side at startup, pauses watches
 * after five minutes in the background (Settings › Refresh & watch), and shows
 * the backend's own notices as toasts.
 */
export function useBackendSync() {
  const toast = useToast();
  const paused = useRef(false);

  useEffect(() => {
    if (!backend) return;
    const api = backend;
    void api.setMetricsInterval(readPreference("settings.metricsIntervalSec", 15));
    void api.setUpdateMethod(readPreference<"watch" | "poll">("settings.updateMethod", "watch"));
    void api.setCacheBudget(readPreference("settings.cacheBudgetEnabled", false) ? readPreference("settings.cacheBudgetMB", 1024) : 0);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (!readPreference("settings.pauseBackgroundWatches", true)) return;
        timer = setTimeout(() => {
          void api.pauseWatches().then((ids) => (paused.current = ids.length > 0));
        }, BACKGROUND_PAUSE_MS);
      } else {
        if (timer) clearTimeout(timer);
        timer = null;
        if (paused.current) {
          paused.current = false;
          void api.resumeWatches();
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    const off = onEvent<{ kind: "info" | "warning"; title: string; detail?: string }>(EVENTS.notice, (n) =>
      toast.show({ kind: n.kind === "warning" ? "error" : "success", title: n.title, detail: n.detail }),
    );
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer) clearTimeout(timer);
      off();
    };
  }, []);
}
