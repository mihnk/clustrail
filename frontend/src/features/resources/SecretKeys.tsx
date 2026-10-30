import { useEffect, useState } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound } from "lucide-react";
import { backend, errorText } from "@/backend/client";
import { Button, IconButton } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export interface SecretKeyInfo {
  key: string;
  bytes: number;
}

/**
 * A Secret's keys, values hidden until you reveal one (like Lens). Revealing
 * reads the value from the API server; Clustrail logs that it happened, not the value.
 */
export function SecretKeys({
  cluster,
  namespace,
  name,
  keys: given,
  type,
  className,
}: {
  cluster: string;
  namespace: string;
  name: string;
  keys?: SecretKeyInfo[];
  type?: string;
  className?: string;
}) {
  const [keys, setKeys] = useState<SecretKeyInfo[] | null>(given ?? null);
  const [kind, setKind] = useState(type);
  const [shown, setShown] = useState<Record<string, { value: string; binary: boolean } | { error: string }>>({});
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    setShown({});
    if (given) {
      setKeys(given);
      return;
    }
    if (!backend) return;
    let cancelled = false;
    void backend
      .getObject(cluster, "Secret", namespace, name)
      .then((o) => {
        if (cancelled) return;
        setKeys(o.secret?.keys ?? []);
        setKind(o.secret?.type);
      })
      .catch(() => !cancelled && setKeys([]));
    return () => {
      cancelled = true;
    };
  }, [cluster, namespace, name, given]);

  const reveal = (key: string) => {
    if (!backend) return;
    void backend
      .revealSecretKey(cluster, namespace, name, key)
      .then((v) => setShown((s) => ({ ...s, [key]: v })))
      .catch((e) => setShown((s) => ({ ...s, [key]: { error: errorText(e) } })));
  };
  const hide = (key: string) =>
    setShown((s) => {
      const next = { ...s };
      delete next[key];
      return next;
    });

  if (keys === null) return <p className="m-0 text-ui text-fg-muted">Reading keys…</p>;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="flex items-center gap-1.5 text-meta text-fg-muted">
        <KeyRound className="size-3.5" aria-hidden />
        {keys.length} {keys.length === 1 ? "key" : "keys"}
        {kind ? ` · ${kind}` : ""} · values hidden until you show one
      </span>
      {keys.map((k) => {
        const v = shown[k.key];
        return (
          <div key={k.key} className="flex flex-col gap-1 rounded-md border border-line px-2.5 py-1.5">
            <div className="flex items-center gap-2 text-ui">
              <span className="truncate font-mono font-medium">{k.key}</span>
              <span className="text-meta text-fg-muted">{k.bytes} bytes</span>
              <div className="flex-1" />
              {v && "value" in v && (
                <IconButton
                  aria-label={copied === k.key ? "Copied" : `Copy ${k.key}`}
                  className="size-[22px] [&_svg]:size-3.5"
                  onClick={() =>
                    void navigator.clipboard?.writeText(v.value).then(() => {
                      setCopied(k.key);
                      setTimeout(() => setCopied(null), 1200);
                    })
                  }
                >
                  {copied === k.key ? <Check className="text-status-healthy" /> : <Copy />}
                </IconButton>
              )}
              <Button size="sm" variant="ghost" disabled={!backend} onClick={() => (v ? hide(k.key) : reveal(k.key))}>
                {v ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                {v ? "Hide" : "Show"}
              </Button>
            </div>
            {v && "value" in v && (
              <pre className="selectable m-0 max-h-[160px] overflow-auto whitespace-pre-wrap break-all rounded bg-surface-app px-2 py-1 font-mono text-meta text-fg">
                {v.value}
                {v.binary && <span className="block text-fg-muted">(binary, shown as base64)</span>}
              </pre>
            )}
            {v && "error" in v && <span className="selectable font-mono text-meta text-status-critical">{v.error}</span>}
          </div>
        );
      })}
    </div>
  );
}
