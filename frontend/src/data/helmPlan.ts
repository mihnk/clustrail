// The rollback summary from two stored manifests (desktop mode). Its own
// module: the YAML parser it needs is loaded with the Helm views, not at start.
import { parseAllDocuments } from "yaml";

export interface RollbackPlan {
  changed: string;
  removed?: string;
  added?: string;
  hooks?: string;
  options: string;
}

interface ManifestDoc {
  key: string;
  text: string;
  images: string[];
}

function manifestDocs(manifest: string): Map<string, ManifestDoc> {
  const out = new Map<string, ManifestDoc>();
  for (const doc of parseAllDocuments(manifest)) {
    const obj = doc.toJS() as { kind?: string; metadata?: { name?: string } } | null;
    if (!obj?.kind) continue;
    const key = `${obj.kind} ${obj.metadata?.name ?? ""}`.trim();
    // "# Source:" comments name the template file; they do not change the object.
    const text = doc.toString().replace(/^# Source:.*$/gm, "").trim();
    const images = [...text.matchAll(/^\s*image:\s*"?([^"\s]+)"?/gm)].map((m) => m[1]!);
    out.set(key, { key, text, images });
  }
  return out;
}

const tag = (image: string) => image.slice(image.lastIndexOf(":") + 1);

/** What `helm rollback` to the target revision changes, from the two stored manifests. */
export function planFromManifests(current: string, target: string, targetHooks: { name: string; kind: string; events: string[] }[]): RollbackPlan {
  const a = manifestDocs(current);
  const b = manifestDocs(target);
  const changed: string[] = [];
  for (const [key, doc] of b) {
    const before = a.get(key);
    if (!before || before.text === doc.text) continue;
    const imgFrom = before.images.find((img, i) => img !== doc.images[i]);
    const imgTo = doc.images[before.images.indexOf(imgFrom ?? "")];
    changed.push(imgFrom && imgTo ? `${key} image ${tag(imgFrom)} → ${tag(imgTo)}` : key);
  }
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const added = [...b.keys()].filter((k) => !a.has(k));
  const hooks = targetHooks.filter((h) => h.events.some((e) => e === "pre-rollback" || e === "post-rollback"));
  return {
    changed: changed.length ? `${changed.length} resource${changed.length === 1 ? "" : "s"} — ${changed.join(", ")}` : "no resource changes",
    removed: removed.length ? removed.join(", ") : undefined,
    added: added.length ? added.join(", ") : undefined,
    hooks: hooks.length ? hooks.map((h) => `${h.events.filter((e) => e.endsWith("rollback")).join("/")} ${h.kind} ${h.name}`).join(", ") : undefined,
    options: "wait 5m · no force · no cleanup-on-fail",
  };
}
