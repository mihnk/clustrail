import { useEffect, useState } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound, Pencil } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { SecretEditor } from "./SecretEditor";
import { backend, errorText } from "@/backend/client";
import { Button, IconButton } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import { useQuery } from "@/lib/useQuery";

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
  // Keys come with the row when it has them; otherwise from the object (no values).
  const q = useQuery(!given && backend ? `getObject|${cluster}|Secret|${namespace}|${name}` : null, () => backend!.getObject(cluster, "Secret", namespace, name));
  const keys: SecretKeyInfo[] | null = given ?? (q.data ? (q.data.secret?.keys ?? []) : q.error ? [] : null);
  const kind = given ? type : (q.data?.secret?.type ?? type);
  const [shown, setShown] = useState<Record<string, { value: string; binary: boolean } | { error: string }>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const readOnly = useWorkspace().clusterById(cluster)?.readOnly;

  // Revealed values and the editor belong to one Secret.
  useEffect(() => {
    setShown({});
    setEditing(false);
  }, [cluster, namespace, name]);

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

  if (keys === null) return <p className="m-0 text-ui text-fg-muted">{t("Reading keys…")}</p>;
  if (editing)
    return (
      <div className={className}>
        <SecretEditor
          cluster={cluster}
          namespace={namespace}
          name={name}
          onDone={() => {
            setEditing(false);
            setShown({});
            q.refresh();
          }}
        />
      </div>
    );
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="flex items-center gap-1.5 text-meta text-fg-muted">
        <KeyRound className="size-3.5" aria-hidden />
        {t(keys.length === 1 ? "1 key" : "{n} keys", { n: keys.length })}
        {kind ? ` · ${kind}` : ""}{" "}{t("· values hidden until you show one")}
        <Button size="sm" variant="ghost" className="ml-auto" disabled={!backend || readOnly} title={readOnly ? t("Read-only context") : undefined} onClick={() => setEditing(true)}>
          <Pencil aria-hidden />
          {t("Edit")}
        </Button>
      </span>
      {keys.map((k) => {
        const v = shown[k.key];
        return (
          <div key={k.key} className="flex flex-col gap-1 rounded-md border border-line px-2.5 py-1.5">
            <div className="flex items-center gap-2 text-ui">
              <span className="truncate font-mono font-medium">{k.key}</span>
              <span className="text-meta text-fg-muted">{k.bytes}{" "}{t("bytes")}</span>
              <div className="flex-1" />
              {v && "value" in v && (
                <IconButton
                  aria-label={copied === k.key ? t("Copied") : t("Copy {key}", { key: k.key })}
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
                {v ? t("Hide") : t("Show")}
              </Button>
            </div>
            {v && "value" in v && (
              <pre className="selectable m-0 max-h-[160px] overflow-auto whitespace-pre-wrap break-all rounded bg-surface-app px-2 py-1 font-mono text-meta text-fg">
                {v.value}
                {v.binary && <span className="block text-fg-muted">{t("(binary, shown as base64)")}</span>}
              </pre>
            )}
            {v && "error" in v && <span className="selectable font-mono text-meta text-status-critical">{v.error}</span>}
          </div>
        );
      })}
    </div>
  );
}
