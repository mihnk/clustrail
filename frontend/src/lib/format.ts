export function formatCpu(milli: number | null): string {
  if (milli === null) return "—";
  return milli >= 1000 ? `${(milli / 1000).toFixed(milli >= 10000 ? 0 : 1)}` : `${milli}m`;
}

export function formatMemory(mib: number | null): string {
  if (mib === null) return "—";
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)}Gi` : `${mib}Mi`;
}

/** kubectl-style age: 45s, 12m, 3h, 9d, 1y. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 365 * 86400) return `${Math.floor(seconds / 86400)}d`;
  return `${Math.floor(seconds / (365 * 86400))}y`;
}

/** "arn:aws:eks:eu-west-1:482100000000:cluster/x" -> account shortened to "4821…". */
export function shortContext(context: string): string {
  return context.replace(/:(\d{4})\d{8}:/, ":$1…:");
}

/** "…7d9f8b6c4-x2kqp" style shortening keeps the unique suffix visible. */
export function shortName(name: string, keep = 16): string {
  return name.length <= keep ? name : `…${name.slice(-keep)}`;
}
