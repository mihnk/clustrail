import { useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import {
  Box,
  KeyRound,
  Layers,
  Lock,
  Moon,
  Network,
  RotateCcw,
  Route,
  Search,
  Server,
  Settings,
  Sun,
} from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { IS_MOCK } from "@/data/mock";
import { useConfirm } from "@/components/safety/ConfirmationDialog";
import { restartDeploymentRequest } from "@/features/deployments/requests";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { Kbd } from "@/components/ui/kbd";
import type { Environment } from "@/data/types";
import { cn } from "@/lib/cn";
import { modKey } from "@/lib/platform";

type Section = "Resources" | "Actions" | "Navigate";
const SCOPES: (Section | "All")[] = ["All", "Resources", "Actions", "Navigate"];

interface Item {
  id: string;
  section: Section;
  icon: ReactNode;
  label: ReactNode;
  detail?: string;
  env?: Environment;
  /** Shown for mutations on protected clusters. */
  confirm?: boolean;
  haystack: string;
  run: () => void;
}

const MAX_PER_SECTION = 6;

/** ⌘K: resources, actions and navigation in one list. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const { confirm } = useConfirm();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<(typeof SCOPES)[number]>("All");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const all = useMemo<Item[]>(() => {
    const items: Item[] = [];
    for (const d of ws.deployments) {
      if (!ws.selectedClusterIds.includes(d.cluster)) continue;
      const cluster = ws.clusterById(d.cluster);
      items.push({
        id: `deploy:${d.id}`,
        section: "Resources",
        icon: <Layers />,
        label: <span className="font-mono">{d.name}</span>,
        detail: `Deployment · ${d.cluster}`,
        env: d.env,
        haystack: `${d.name} deployment ${d.namespace} ${d.cluster}`,
        run: () => {
          ws.openView({ kind: "deployments", title: "Deployments" });
          ws.revealResource("deployment", d.id);
        },
      });
      items.push({
        id: `restart:${d.id}`,
        section: "Actions",
        icon: <RotateCcw />,
        label: (
          <>
            Restart rollout… <span className="font-mono">{d.name}</span>
          </>
        ),
        detail: d.cluster,
        env: d.env,
        confirm: cluster?.protected,
        haystack: `restart rollout ${d.name} ${d.cluster}`,
        run: () => confirm(restartDeploymentRequest(d, cluster, () => ws.restartDeployment(d.id))),
      });
    }
    for (const p of ws.pods) {
      items.push({
        id: `pod:${p.id}`,
        section: "Resources",
        icon: <Box />,
        label: <span className="font-mono">{p.name}</span>,
        detail: `Pod · ${p.namespace} · ${p.cluster}`,
        env: p.env,
        haystack: `${p.name} pod ${p.namespace} ${p.cluster}`,
        run: () => {
          ws.openView({ kind: "pods", title: "Pods" });
          ws.revealResource("pod", p.id);
        },
      });
    }
    for (const c of ws.clusters) {
      items.push({
        id: `cluster:${c.id}`,
        section: "Resources",
        icon: <Network />,
        label: <span className="font-mono">{c.name}</span>,
        detail: `Cluster · ${c.summary ?? c.connection}`,
        env: c.env,
        haystack: `${c.name} cluster ${c.context}`,
        run: () => {
          ws.openView({ kind: "clusters", title: "Clusters" });
          ws.revealResource("cluster", c.id);
        },
      });
    }
    const nav: [string, ReactNode, () => void][] = [
      ["Clusters", <Network key="c" />, () => ws.openView({ kind: "clusters", title: "Clusters" })],
      ["Pods", <Box key="p" />, () => ws.openView({ kind: "pods", title: "Pods" })],
      ["Deployments", <Layers key="d" />, () => ws.openView({ kind: "deployments", title: "Deployments" })],
      ["Nodes", <Server key="n" />, () => ws.openView({ kind: "nodes", title: "Nodes" })],
      [
        IS_MOCK ? "Investigation · checkout-api" : "Investigation · pinned evidence",
        <Route key="i" />,
        () => ws.openTab("inv-checkout-api") || ws.openView({ id: "inv-checkout-api", kind: "investigation", title: "Investigation" }),
      ],
      ["Connections", <KeyRound key="k" />, () => ws.openView({ kind: "connections", title: "Connections" })],
      ["Settings", <Settings key="s" />, () => ws.openView({ kind: "settings", title: "Settings" })],
    ];
    for (const [label, icon, run] of nav) {
      items.push({ id: `nav:${label}`, section: "Navigate", icon, label: `Go to ${label}`, haystack: `go to ${label}`, run });
    }
    items.push({
      id: "theme",
      section: "Navigate",
      icon: ws.theme === "dark" ? <Sun /> : <Moon />,
      label: `Switch to ${ws.theme === "dark" ? "light" : "dark"} theme`,
      haystack: "theme light dark appearance",
      run: () => ws.setTheme(ws.theme === "dark" ? "light" : "dark"),
    });
    return items;
  }, [ws, confirm]);

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = all.filter(
      (it) => (scope === "All" || it.section === scope) && words.every((w) => it.haystack.toLowerCase().includes(w)),
    );
    // Without a query, show navigation first; with one, resources first.
    const order: Section[] = words.length ? ["Resources", "Actions", "Navigate"] : ["Navigate", "Resources", "Actions"];
    return order.flatMap((section) =>
      matches.filter((m) => m.section === section).slice(0, words.length || section === "Navigate" ? MAX_PER_SECTION : 3),
    );
  }, [all, query, scope]);

  const run = (it: Item | undefined) => {
    if (!it) return;
    onOpenChange(false);
    setQuery("");
    it.run();
  };

  const move = (delta: number) => {
    const next = Math.max(0, Math.min(results.length - 1, active + delta));
    setActive(next);
    listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[72px] z-50 flex max-h-[min(560px,calc(100vh-120px))] w-[600px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col rounded-lg border border-line-strong bg-surface-elevated p-1.5 text-fg shadow-dialog"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <label className="flex h-9 shrink-0 items-center gap-2 rounded-md border border-accent bg-surface-panel px-2.5 text-fg-muted">
            <Search className="size-4" aria-hidden />
            <span className="sr-only">Search resources and commands</span>
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") move(1);
                else if (e.key === "ArrowUp") move(-1);
                else if (e.key === "Enter") run(results[active]);
                else if (e.key === "Tab") {
                  setScope(SCOPES[(SCOPES.indexOf(scope) + (e.shiftKey ? SCOPES.length - 1 : 1)) % SCOPES.length]!);
                  setActive(0);
                } else return;
                e.preventDefault();
              }}
              placeholder="Go to resource or run command…"
              spellCheck={false}
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              aria-activedescendant={results[active] ? `palette-${active}` : undefined}
              className="min-w-0 flex-1 border-0 bg-transparent text-body text-fg outline-none placeholder:text-fg-muted"
            />
            {scope !== "All" && (
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-label font-medium text-fg">{scope}</span>
            )}
          </label>

          <div ref={listRef} id="palette-list" role="listbox" aria-label="Results" className="mt-1 min-h-0 overflow-y-auto">
            {results.length === 0 && <p className="m-0 px-2.5 py-6 text-center text-cell text-fg-muted">Nothing matches “{query}”.</p>}
            {results.map((it, i) => (
              <div key={it.id}>
                {(i === 0 || results[i - 1]!.section !== it.section) && (
                  <div className="section-label px-2.5 pb-1 pt-2 text-2xs">{it.section}</div>
                )}
                <div
                  id={`palette-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(it)}
                  className={cn(
                    "flex h-[30px] cursor-default items-center gap-2 rounded-md px-2.5 text-cell [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-fg-muted",
                    i === active && "bg-accent-soft",
                  )}
                >
                  {it.icon}
                  <span className="truncate">{it.label}</span>
                  {it.detail && <span className="min-w-0 flex-1 truncate text-meta text-fg-muted">{it.detail}</span>}
                  {!it.detail && <span className="flex-1" />}
                  {it.confirm && (
                    <span className="flex items-center gap-1 text-meta text-fg-muted">
                      <Lock className="size-3 text-env-prod-ink" aria-hidden />
                      confirm
                    </span>
                  )}
                  {it.env && <EnvironmentBadge env={it.env} size="sm" className="text-[9.5px]" />}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-1 flex shrink-0 items-center gap-2.5 border-t border-line px-2 pb-0.5 pt-1.5 text-meta text-fg-muted">
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> open
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↑↓</Kbd> move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Tab</Kbd> scope by kind
            </span>
            <div className="flex-1" />
            <span className="flex items-center gap-1">
              <Kbd>{modKey}K</Kbd> toggle
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
