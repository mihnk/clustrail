import { useEffect, useLayoutEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { MetricSeries } from "@/data/types";

/**
 * Compact time-series chart (uPlot, canvas). Draws the series plus optional
 * request/limit guides and event markers. No animation; redraws only when
 * data, size or theme change.
 */
export function MetricsChart({
  series,
  height = 70,
  themeKey,
  label,
  onHover,
}: {
  series: MetricSeries;
  height?: number;
  /** Changes when the theme changes; colors are read from CSS tokens. */
  themeKey: string;
  /** Accessible description of what the chart shows. */
  label: string;
  onHover?: (index: number | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const hoverRef = useRef(onHover);
  hoverRef.current = onHover;
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || width === 0) return;
    const css = getComputedStyle(el);
    const token = (name: string) => css.getPropertyValue(name).trim();
    const accent = token("--accent");
    const critical = token("--status-critical");
    const guide = token("--line-strong");
    const axis = token("--line");

    const top = series.limit ?? Math.max(...series.values);
    const opts: uPlot.Options = {
      width,
      height,
      padding: [6, 4, 1, 4],
      legend: { show: false },
      cursor: { y: false, drag: { x: false, y: false }, points: { size: 6, fill: accent } },
      select: { show: false, left: 0, top: 0, width: 0, height: 0 },
      axes: [{ show: false }, { show: false }],
      scales: { x: { time: true }, y: { range: [top * 0.5, top * 1.04] } },
      series: [{}, { stroke: accent, width: 1.6, points: { show: false } }],
      hooks: {
        draw: [
          (u) => {
            const ctx = u.ctx;
            const { left, width: w, top: t, height: h } = u.bbox;
            const dpr = devicePixelRatio || 1;
            const hline = (value: number, color: string, dash: number[]) => {
              const y = Math.round(u.valToPos(value, "y", true)) + 0.5;
              ctx.save();
              ctx.strokeStyle = color;
              ctx.lineWidth = dpr;
              ctx.setLineDash(dash.map((d) => d * dpr));
              ctx.beginPath();
              ctx.moveTo(left, y);
              ctx.lineTo(left + w, y);
              ctx.stroke();
              ctx.restore();
            };
            if (series.limit !== undefined) hline(series.limit, critical, [3, 3]);
            if (series.request !== undefined) hline(series.request, guide, [2, 3]);
            // Baseline
            ctx.save();
            ctx.strokeStyle = axis;
            ctx.lineWidth = dpr;
            ctx.beginPath();
            ctx.moveTo(left, t + h - 0.5);
            ctx.lineTo(left + w, t + h - 0.5);
            ctx.stroke();
            ctx.restore();
            // Event markers (e.g. OOMKilled) at the limit line.
            if (series.markers && series.limit !== undefined) {
              ctx.save();
              ctx.fillStyle = critical;
              for (const ts of series.markers) {
                ctx.beginPath();
                ctx.arc(u.valToPos(ts, "x", true), u.valToPos(series.limit, "y", true), 2.6 * dpr, 0, Math.PI * 2);
                ctx.fill();
              }
              ctx.restore();
            }
          },
        ],
        setCursor: [(u) => hoverRef.current?.(u.cursor.idx ?? null)],
      },
    };
    const plot = new uPlot(opts, [series.timestamps, series.values], el);
    plotRef.current = plot;
    return () => {
      plot.destroy();
      plotRef.current = null;
    };
    // Width changes are handled by setSize below without rebuilding the plot.
  }, [series, height, themeKey, width === 0]);

  useEffect(() => {
    if (width > 0) plotRef.current?.setSize({ width, height });
  }, [width, height]);

  return (
    <div
      ref={wrapRef}
      role="img"
      aria-label={label}
      className="w-full"
      style={{ height }}
      onMouseLeave={() => hoverRef.current?.(null)}
    />
  );
}
