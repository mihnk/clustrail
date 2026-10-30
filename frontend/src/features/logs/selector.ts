// Label selectors as kubectl writes them, matched in the UI to preview what a
// log source will follow. The backend parses the same text with
// k8s.io/apimachinery/pkg/labels, which stays the authority.

type Requirement =
  | { op: "=" | "!="; key: string; value: string }
  | { op: "in" | "notin"; key: string; values: string[] }
  | { op: "exists" | "!exists"; key: string };

const KEY = /^[A-Za-z0-9]([-A-Za-z0-9_./]*[A-Za-z0-9])?$/;
const VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;

/** Splits on commas outside parentheses. */
function terms(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((t) => t.trim()).filter(Boolean);
}

/** Parses a selector; returns an error message instead when it is not valid. */
export function parseSelector(text: string): Requirement[] | string {
  const reqs: Requirement[] = [];
  for (const term of terms(text)) {
    let m: RegExpMatchArray | null;
    if ((m = term.match(/^(\S+?)\s+(in|notin)\s*\((.*)\)$/))) {
      const values = m[3]!.split(",").map((v) => v.trim());
      if (!KEY.test(m[1]!) || values.some((v) => !VALUE.test(v))) return `invalid term "${term}"`;
      reqs.push({ op: m[2] as "in" | "notin", key: m[1]!, values });
    } else if ((m = term.match(/^([^=!\s]+)\s*(==|=|!=)\s*(\S*)$/))) {
      if (!KEY.test(m[1]!) || !VALUE.test(m[3]!)) return `invalid term "${term}"`;
      reqs.push({ op: m[2] === "!=" ? "!=" : "=", key: m[1]!, value: m[3]! });
    } else if ((m = term.match(/^!\s*(\S+)$/))) {
      if (!KEY.test(m[1]!)) return `invalid term "${term}"`;
      reqs.push({ op: "!exists", key: m[1]! });
    } else if (KEY.test(term)) {
      reqs.push({ op: "exists", key: term });
    } else {
      return `invalid term "${term}"`;
    }
  }
  return reqs.length ? reqs : "empty selector";
}

export function matches(reqs: Requirement[], labels: Record<string, string> | undefined): boolean {
  const l = labels ?? {};
  return reqs.every((r) => {
    const has = Object.prototype.hasOwnProperty.call(l, r.key);
    switch (r.op) {
      case "=":
        return has && l[r.key] === r.value;
      case "!=":
        return !has || l[r.key] !== r.value;
      case "in":
        return has && r.values.includes(l[r.key]!);
      case "notin":
        return !has || !r.values.includes(l[r.key]!);
      case "exists":
        return has;
      case "!exists":
        return !has;
    }
  });
}
