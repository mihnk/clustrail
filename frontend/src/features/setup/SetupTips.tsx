import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { useWorkspace } from "@/app/workspace";
import { modKey } from "@/lib/platform";
import { t, tn } from "@/i18n";
import type { SetupSummary } from "./SetupFlow";

// The first workspace after setup: three tips, one at a time, pointing at
// the element they describe, and a summary of what setup did.

interface Tip {
  anchor: string;
  /** Where the tip sits relative to its anchor. */
  side: "right" | "below" | "above";
  body: ReactNode;
}

export function SetupTips({ summary, onClose }: { summary: SetupSummary; onClose: () => void }) {
  const ws = useWorkspace();
  const all: Tip[] = [
    { anchor: "clusters", side: "right", body: tn("{lead} Every explorer shows all selected clusters together, with a cluster column.", { lead: <b className="font-semibold">{t("Pick clusters here.")}</b> }) },
    {
      anchor: "palette",
      side: "below",
      body: tn("{lead} — a pod by name, an action like “restart”, a cluster or a setting.", { lead: <b className="font-semibold">{t("{key} finds anything", { key: `${modKey}K` })}</b> }),
    },
    {
      anchor: "protected",
      side: "above",
      body: tn("{lead} Changes and shells on {prod} clusters show their impact and ask you to type the name.", {
        lead: <b className="font-semibold">{t("Production is protected.")}</b>,
        prod: <EnvironmentBadge env="prod" size="sm" />,
      }),
    },
  ];
  // The workspace mounts with this component: look for the anchors once it has painted.
  const [present, setPresent] = useState<string[] | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setPresent(all.map((a) => a.anchor).filter((a) => document.querySelector(`[data-tour="${a}"]`))), 400);
    return () => clearTimeout(timer);
  }, []);
  const tips = all.filter((tip) => present?.includes(tip.anchor));
  const [index, setIndex] = useState(0);
  const [showTips, setShowTips] = useState(true);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const tip = showTips ? tips[index] : undefined;

  useLayoutEffect(() => {
    if (!tip) return;
    const place = () => {
      const r = document.querySelector(`[data-tour="${tip.anchor}"]`)?.getBoundingClientRect();
      if (!r) return setPos(null);
      const w = 268;
      if (tip.side === "right") setPos({ left: r.right + 12, top: r.top + 8 });
      else if (tip.side === "below") setPos({ left: Math.min(window.innerWidth - w - 12, r.left), top: r.bottom + 10 });
      else setPos({ left: Math.min(window.innerWidth - w - 12, Math.max(12, r.right - w)), top: r.top - 10 });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [tip?.anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {tip && pos && (
        <div
          role="note"
          aria-label={t("Tip {n} of {total}", { n: index + 1, total: tips.length })}
          className="fixed z-50 flex w-[268px] flex-col gap-2 rounded-[10px] border border-line-selected bg-surface-elevated p-3 text-[12.5px] leading-[1.45] shadow-menu"
          style={{ left: pos.left, top: pos.top, transform: tip.side === "above" ? "translateY(-100%)" : undefined }}
        >
          <span className="text-label font-semibold uppercase tracking-[.06em] text-accent">{t("Tip {n} of {total}", { n: index + 1, total: tips.length })}</span>
          <span>{tip.body}</span>
          <div className="flex">
            <span className="flex-1" />
            <Button size="sm" onClick={() => (index + 1 < tips.length ? setIndex(index + 1) : setShowTips(false))}>
              {t("Got it")}
            </Button>
          </div>
        </div>
      )}
      <div role="status" className="fixed bottom-[34px] left-[236px] z-50 flex w-[560px] items-center gap-3 rounded-[10px] border border-line-strong bg-surface-elevated px-3.5 py-3 text-[12.5px] shadow-menu">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span>
            <b className="font-semibold">{t("Setup complete.")}</b>{" "}
            {t("{connected} clusters connected, {protected} protected.", { connected: summary.connected, protected: summary.protectedCount })}
          </span>
          {summary.attention.length > 0 && (
            <span className="truncate text-meta text-fg-muted">
              {summary.attention.length === 1
                ? t("{names} needs attention.", { names: summary.attention[0] })
                : t("{names} need attention.", { names: summary.attention.join(", ") })}
            </span>
          )}
        </span>
        <Button
          size="sm"
          onClick={() => {
            ws.openView({ kind: "connections", title: t("Connections") });
            onClose();
          }}
        >
          {t("Open Connections")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {showTips && tips.length > 0 ? t("Hide all tips") : t("Close")}
        </Button>
      </div>
    </>
  );
}
