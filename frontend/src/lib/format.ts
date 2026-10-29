export function formatCpu(milli: number | null): string {
  if (milli === null) return "—";
  return milli >= 1000 ? `${(milli / 1000).toFixed(milli >= 10000 ? 0 : 1)}` : `${milli}m`;
}

export function formatMemory(mib: number | null): string {
  if (mib === null) return "—";
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)}Gi` : `${mib}Mi`;
}

/** kubectl-style age: 45s, 12m, 3h, 9d. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** "…7d9f8b6c4-x2kqp" style shortening keeps the unique suffix visible. */
export function shortName(name: string, keep = 16): string {
  return name.length <= keep ? name : `…${name.slice(-keep)}`;
}
