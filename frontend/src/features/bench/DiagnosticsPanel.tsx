import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { backend, type BackendDiagnostics } from "@/backend/client";
import { podStream } from "@/backend/podStream";
import { IconButton } from "@/components/ui/button";
import { stats } from "./monitor";

/** Development diagnostics (⌘⇧D / Ctrl+Shift+D): Go process, pipeline and UI timing. */
export function DiagnosticsPanel({ onClose }: { onClose: () => void }) {
  const [d, setD] = useState<BackendDiagnostics | null>(null);
  const [fps, setFps] = useState(0);
  useEffect(() => {
    if (!backend) return;
    const api = backend;
    let cancelled = false;
    const load = () => void api.diagnostics().then((x) => !cancelled && setD(x));
    load();
    const t = setInterval(load, 1000);
    let frames = 0;
    let raf = 0;
    const tick = () => {
      frames++;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const f = setInterval(() => {
      setFps(frames);
      frames = 0;
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(t);
      clearInterval(f);
      cancelAnimationFrame(raf);
    };
  }, []);
  const ui = stats(podStream.metrics.renderMs);
  const row = (k: string, v: string | number) => (
    <div className="flex justify-between gap-3">
      <span className="text-fg-muted">{k}</span>
      <span className="font-mono">{v}</span>
    </div>
  );
  return (
    <div className="fixed bottom-8 right-3 z-50 w-[300px] rounded-lg border border-line-strong bg-surface-elevated p-3 text-meta text-fg shadow-dialog">
      <div className="mb-1.5 flex items-center justify-between">
        <b className="text-ui font-semibold">Diagnostics</b>
        <IconButton aria-label="Close diagnostics" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      {row("UI frames/s", fps)}
      {row("rows in UI", podStream.rows().length.toLocaleString())}
      {row("stream frames · gaps", `${podStream.metrics.frames} · ${podStream.metrics.gaps}`)}
      {row("receive → paint p50/p95", `${ui.p50} / ${ui.p95} ms`)}
      {d && (
        <>
          <div className="my-1.5 border-t border-line" />
          {row("Go CPU", `${d.process.cpuPercent.toFixed(0)}%`)}
          {row("Go heap in use", `${d.process.heapInuseMB.toFixed(0)} MB`)}
          {row("goroutines · GC", `${d.process.goroutines} · ${d.process.numGC}`)}
          {row("watches · consumers", `${d.watches} · ${d.consumers}`)}
          {row("cached rows", d.rows.toLocaleString())}
          {row("queue (coalesced)", d.pending)}
          {row("events · frames", `${d.events.toLocaleString()} · ${d.frames.toLocaleString()}`)}
          {row("send full · resyncs", `${d.sendFull} · ${d.resyncs}`)}
          {row("backend queue p95", `${d.queue.p95} ms`)}
          {row("event → visible p50/p95", `${d.visible.p50} / ${d.visible.p95} ms`)}
        </>
      )}
    </div>
  );
}
