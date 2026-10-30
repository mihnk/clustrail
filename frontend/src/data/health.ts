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
  cordoned: 3,
  paused: 4,
  terminating: 5,
  unknown: 6,
  healthy: 7,
  completed: 8,
  idle: 9,
};
