import type { Health } from "./types";

/** States that need a human: shown under "Attention" and counted in pills. */
export function isAttention(health: Health): boolean {
  return health === "failed" || health === "warning" || health === "progressing" || health === "terminating";
}

/** Sort order for "attention first". */
export const healthRank: Record<Health, number> = {
  failed: 0,
  warning: 1,
  progressing: 2,
  paused: 3,
  terminating: 4,
  unknown: 5,
  healthy: 6,
  completed: 7,
  idle: 8,
};
