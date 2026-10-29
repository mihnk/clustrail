import type { PodRow } from "@/data/types";
import { isAttention } from "@/data/health";

// Filter text: free words plus `key:value` tokens, e.g.
//   checkout ns:payments status:attention cluster:prod-eu-west-1 node:ip-10-42
// Tokens with the same key are OR'ed, different keys are AND'ed.

const KEYS: Record<string, keyof PodRow | "status"> = {
  ns: "namespace",
  namespace: "namespace",
  cluster: "cluster",
  node: "node",
  status: "status",
};

export interface ParsedFilter {
  words: string[];
  tokens: Map<keyof PodRow | "status", string[]>;
}

export function parseFilter(text: string): ParsedFilter {
  const words: string[] = [];
  const tokens = new Map<keyof PodRow | "status", string[]>();
  for (const part of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    const m = part.match(/^([a-z]+):(.+)$/);
    const key = m?.[1] ? KEYS[m[1]] : undefined;
    if (m?.[2] && key) tokens.set(key, [...(tokens.get(key) ?? []), m[2]]);
    else words.push(part);
  }
  return { words, tokens };
}

export function matchesFilter(pod: PodRow, f: ParsedFilter): boolean {
  for (const [key, values] of f.tokens) {
    const ok = values.some((v) => {
      if (key === "status") {
        return v === "attention" ? isAttention(pod.health) : pod.status.toLowerCase().startsWith(v) || pod.reason.toLowerCase().includes(v);
      }
      return String(pod[key]).toLowerCase().includes(v);
    });
    if (!ok) return false;
  }
  if (f.words.length === 0) return true;
  const haystack = `${pod.name} ${pod.namespace} ${pod.cluster} ${pod.node} ${pod.status}`.toLowerCase();
  return f.words.every((w) => haystack.includes(w));
}
