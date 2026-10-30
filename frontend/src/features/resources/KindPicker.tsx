import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { LayoutGrid, Search } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { backend, errorText, type KindInfo } from "@/backend/client";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/cn";
import { kindKey, listLabel } from "./kinds";

interface Entry extends KindInfo {
  key: string;
  clusters: string[];
}

/** ⌘J: every kind the selected clusters serve (CRDs included); Enter opens its list. */
export function KindPicker({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const ws = useWorkspace();
  const [kinds, setKinds] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const connected = ws.selectedClusters.filter((c) => c.connection === "connected").map((c) => c.id);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    if (!backend) {
      setKinds([]);
      return;
    }
    const api = backend;
    let cancelled = false;
    void Promise.all(connected.map((c) => api.resourceKinds(c).then((ks) => ks.map((k) => ({ ...k, cluster: c }))).catch((e) => (setError(errorText(e)), []))))
      .then((all) => {
        if (cancelled) return;
        const byKey = new Map<string, Entry>();
        for (const k of all.flat()) {
          const key = kindKey(k);
          const cur = byKey.get(key);
          if (cur) cur.clusters.push(k.cluster);
          else byKey.set(key, { ...k, key, clusters: [k.cluster] });
        }
        setKinds([...byKey.values()]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, connected.join(",")]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!kinds) return [];
    if (!q) return kinds;
    const score = (k: Entry) => {
      const names = [k.kind.toLowerCase(), k.resource, ...(k.shortNames ?? [])];
      if (names.some((n) => n === q)) return 0;
      if (names.some((n) => n.startsWith(q))) return 1;
      if (`${k.kind} ${k.group} ${k.resource}`.toLowerCase().includes(q)) return 2;
      return -1;
    };
    return kinds
      .map((k) => [k, score(k)] as const)
      .filter(([, s]) => s >= 0)
      .sort((a, b) => a[1] - b[1])
      .map(([k]) => k);
  }, [kinds, query]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const pick = (k: Entry) => {
    onOpenChange(false);
    ws.openView({ kind: "list", title: listLabel(k.key), params: { kind: k.key } });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[96px] z-50 flex max-h-[min(560px,calc(100vh-140px))] w-[620px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col rounded-xl border border-line-strong bg-surface-elevated p-2 text-fg shadow-dialog"
        >
          <Dialog.Title className="sr-only">All resource kinds</Dialog.Title>
          <label className="flex h-9 shrink-0 items-center gap-2 rounded-md border border-accent bg-surface-panel px-2.5 text-fg-muted">
            <Search className="size-4" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(e) => (setQuery(e.target.value), setIndex(0))}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") setIndex((i) => Math.min(shown.length - 1, i + 1));
                else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
                else if (e.key === "Enter" && shown[index]) pick(shown[index]!);
                else return;
                e.preventDefault();
              }}
              placeholder="Kind, resource or short name (svc, sts, cj)…"
              spellCheck={false}
              className="min-w-0 flex-1 border-0 bg-transparent text-cell text-fg outline-none placeholder:text-fg-muted"
            />
            <span className="font-mono text-meta">{kinds ? shown.length : ""}</span>
          </label>
          <ul ref={listRef} role="listbox" aria-label="Resource kinds" className="m-0 mt-1.5 min-h-0 flex-1 list-none overflow-y-auto p-0">
            {kinds === null && <li className="px-2.5 py-2 text-ui text-fg-muted">Reading API discovery…</li>}
            {kinds && !connected.length && <li className="px-2.5 py-2 text-ui text-fg-muted">{backend ? "Select a connected cluster first." : "Needs the desktop app connected to a cluster."}</li>}
            {error && <li className="selectable px-2.5 py-2 font-mono text-meta text-status-warning">{error}</li>}
            {shown.map((k, i) => (
              <li
                key={k.key}
                role="option"
                aria-selected={i === index}
                data-index={i}
                onMouseMove={() => setIndex(i)}
                onClick={() => pick(k)}
                className={cn("flex h-[30px] cursor-default items-center gap-2 rounded-md px-2.5 text-cell", i === index && "bg-surface-selected")}
              >
                <LayoutGrid className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
                <span className="font-medium">{k.kind}</span>
                <span className="truncate font-mono text-meta text-fg-muted">
                  {k.resource}
                  {k.group ? `.${k.group}` : ""}
                  {k.shortNames?.length ? ` · ${k.shortNames.join(", ")}` : ""}
                </span>
                <div className="flex-1" />
                {!k.namespaced && <span className="text-meta text-fg-muted">cluster-scoped</span>}
                {connected.length > 1 && k.clusters.length < connected.length && (
                  <span className="text-meta text-fg-muted">
                    {k.clusters.length}/{connected.length} clusters
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-1 flex shrink-0 items-center gap-2.5 border-t border-line px-2 pb-0.5 pt-1.5 text-meta text-fg-muted">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> open list
            </span>
            <div className="flex-1" />
            <span>From API discovery of the selected clusters</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
