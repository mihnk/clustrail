import type { JobEvent } from "@/backend/client";

/**
 * What a job event means for the UI, given the events already seen. Every
 * event carries the whole job and a sequence number, so a late or repeated
 * event is recognised and dropped: a finished job never comes back as
 * running, and its result is shown once.
 */
export function trackJob(seen: Map<string, number>, j: JobEvent): "stale" | "progress" | "result" {
  const last = seen.get(j.id);
  if (last !== undefined && (last === Infinity || j.seq <= last)) return "stale";
  seen.set(j.id, j.done ? Infinity : j.seq);
  return j.done ? "result" : "progress";
}

/** The notice for a finished job. Unknown is never shown as a success. */
export function jobResultToast(j: JobEvent): { kind: "success" | "error"; title: string; detail?: string; copyText?: string } {
  if (j.state === "succeeded") return { kind: "success", title: j.title.replace(/^(\w+)ing /, (_, v: string) => `${v[0]!.toUpperCase()}${v.slice(1)}ed `), detail: j.detail };
  if (j.state === "unknown") return { kind: "error", title: `${j.title}: result unknown`, detail: j.error, copyText: j.error };
  return { kind: "error", title: `${j.title} failed`, detail: j.error, copyText: j.error };
}
