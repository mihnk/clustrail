import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  Columns3,
  Cpu,
  Download,
  ExternalLink,
  Info,
  KeyRound,
  Keyboard,
  LayoutGrid,
  LifeBuoy,
  Plus,
  RefreshCw,
  Search,
  Shield,
  SquareTerminal,
  Sun,
  Trash2,
} from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { usePersistentState, type Density, type ThemePreference } from "@/app/preferences";
import { useOverlays } from "@/app/shortcuts";
import { Button, IconButton } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Meter } from "@/components/ui/meter";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { Logo } from "@/components/shell/Logo";
import { cn } from "@/lib/cn";


export const APP_VERSION = "0.9.0";

interface Category {
  id: string;
  label: string;
  icon: ReactNode;
  /** Opens another view instead of scrolling. */
  view?: "connections";
}

const CATEGORIES: Category[] = [
  { id: "appearance", label: "Appearance", icon: <Sun /> },
  { id: "clusters", label: "Clusters & namespaces", icon: <LayoutGrid /> },
  { id: "connections", label: "Connections", icon: <KeyRound />, view: "connections" },
  { id: "tables", label: "Tables & columns", icon: <Columns3 /> },
  { id: "watch", label: "Refresh & watch", icon: <RefreshCw /> },
  { id: "perf", label: "Memory & buffers", icon: <Cpu /> },
  { id: "term", label: "Logs & terminal", icon: <SquareTerminal /> },
  { id: "helm", label: "Helm repositories", icon: <LifeBuoy /> },
  { id: "keys", label: "Keyboard shortcuts", icon: <Keyboard /> },
  { id: "privacy", label: "Privacy & diagnostics", icon: <Shield /> },
  { id: "updates", label: "Updates", icon: <Download /> },
  { id: "about", label: "About & licenses", icon: <Info /> },
];

interface HelmRepo {
  name: string;
  url: string;
}

const DEFAULT_REPOS: HelmRepo[] = [
  { name: "ingress-nginx", url: "https://kubernetes.github.io/ingress-nginx" },
  { name: "jetstack", url: "https://charts.jetstack.io" },
  { name: "prometheus-community", url: "https://prometheus-community.github.io/helm-charts" },
  { name: "argo", url: "https://argoproj.github.io/argo-helm" },
];

/** Settings apply immediately and persist locally. */
export function SettingsWorkspace({ active }: { active: boolean }) {
  const ws = useWorkspace();
  const { openHelp } = useOverlays();
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState("appearance");
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [fontSize, setFontSize] = usePersistentState("settings.fontSize", 13);
  const [reduceMotion, setReduceMotion] = usePersistentState("settings.reduceMotion", false);
  const [onLaunch, setOnLaunch] = usePersistentState<"restore" | "clusters">("settings.onLaunch", "restore");
  const [autoConnect, setAutoConnect] = usePersistentState("settings.autoConnect", true);
  const [defaultNs, setDefaultNs] = usePersistentState<"remember" | "all" | "default">("settings.defaultNamespace", "remember");
  const [hideSystem, setHideSystem] = usePersistentState("settings.hideSystemNamespaces", true);
  const [autoHideColumns, setAutoHideColumns] = usePersistentState("settings.autoHideColumns", true);
  const [updateMethod, setUpdateMethod] = usePersistentState<"watch" | "poll">("settings.updateMethod", "watch");
  const [pauseBackground, setPauseBackground] = usePersistentState("settings.pauseBackgroundWatches", true);
  const [metricsInterval, setMetricsInterval] = usePersistentState("settings.metricsIntervalSec", 15);
  const [cacheBudget, setCacheBudget] = usePersistentState("settings.cacheBudgetMB", 1024);
  const [logBuffer, setLogBuffer] = usePersistentState("logs.bufferLines", 100_000);
  const [logMemory, setLogMemory] = usePersistentState("settings.logMemoryMB", 256);
  const [scrollback, setScrollback] = usePersistentState("terminal.scrollback", 10_000);
  const [logTimestamps, setLogTimestamps] = usePersistentState("logs.timestamps", true);
  const [logWrap, setLogWrap] = usePersistentState("logs.wrap", false);
  const [repos, setRepos] = usePersistentState<HelmRepo[]>("settings.helmRepos", DEFAULT_REPOS);
  const [telemetry, setTelemetry] = usePersistentState("settings.telemetry", false);
  const [crashReports, setCrashReports] = usePersistentState<"ask" | "never" | "always">("settings.crashReports", "ask");
  const [updateChannel, setUpdateChannel] = usePersistentState<"daily-stable" | "weekly-stable" | "daily-beta" | "off">("settings.updates", "daily-stable");
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  const cachedObjects = ws.allPods.length + ws.deployments.length + ws.nodes.length + ws.helmReleases.length + ws.gitops.length;
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || t?.closest("input, textarea, [contenteditable]")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const q = query.trim().toLowerCase();
  const show = (...words: string[]) => !q || words.some((w) => w.toLowerCase().includes(q));

  const go = (c: Category) => {
    if (c.view) return ws.openView({ kind: "connections", title: "Connections" });
    setCurrent(c.id);
    scrollRef.current?.querySelector(`#settings-${c.id}`)?.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
  };

  const checkUpdates = () => {
    setChecking(true);
    setTimeout(() => {
      setChecking(false);
      setCheckedAt(new Date().toLocaleTimeString([], { hour12: false }));
    }, 900);
  };

  const sections: { id: string; col: 0 | 1; node: ReactNode }[] = [
    {
      id: "appearance",
      col: 0,
      node: (
        <Section id="appearance" icon={<Sun />} title="Appearance">
          {show("theme", "dark", "light", "system") && (
            <Setting label="Theme" detail="System follows the OS appearance.">
              <Segmented<ThemePreference>
                aria-label="Theme"
                value={ws.themePreference}
                onValueChange={ws.setTheme}
                options={[
                  { value: "system", label: "System" },
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                ]}
              />
            </Setting>
          )}
          {show("density", "row height", "compact") && (
            <Setting label="Density" detail="Row height 24 / 28 / 34 px.">
              <Segmented<Density>
                aria-label="Density"
                value={ws.density}
                onValueChange={ws.setDensity}
                options={[
                  { value: "compact", label: "Compact" },
                  { value: "default", label: "Default" },
                  { value: "comfortable", label: "Comfortable" },
                ]}
              />
            </Setting>
          )}
          {show("interface font size", "zoom") && (
            <Setting label="Interface font size" detail="Scales the whole interface from the 13 px base.">
              <Select
                label="Interface font size"
                value={String(fontSize)}
                onChange={(v) => setFontSize(Number(v))}
                options={[
                  ["12", "12 px"],
                  ["13", "13 px"],
                  ["14", "14 px"],
                ]}
              />
            </Setting>
          )}
          {show("reduce motion", "animation") && (
            <Setting label="Reduce motion" detail="Also follows the OS setting.">
              <Switch checked={reduceMotion} onCheckedChange={setReduceMotion} aria-label="Reduce motion" />
            </Setting>
          )}
        </Section>
      ),
    },
    {
      id: "clusters",
      col: 0,
      node: (
        <Section id="clusters" icon={<LayoutGrid />} title="Clusters & namespaces">
          {show("on launch", "restore", "workspace") && (
            <Setting label="On launch">
              <Select
                label="On launch"
                value={onLaunch}
                onChange={(v) => setOnLaunch(v as typeof onLaunch)}
                options={[
                  ["restore", "Restore last workspace"],
                  ["clusters", "Open Clusters overview"],
                ]}
              />
            </Setting>
          )}
          {show("connect automatically", "auto connect") && (
            <Setting label="Connect automatically" detail="Only clusters that were selected when you quit. Production clusters are never connected without that.">
              <Switch checked={autoConnect} onCheckedChange={setAutoConnect} aria-label="Connect automatically" />
            </Setting>
          )}
          {show("default namespace filter") && (
            <Setting label="Default namespace filter" detail="Applied when a cluster is added to the selection.">
              <Select
                label="Default namespace filter"
                value={defaultNs}
                onChange={(v) => setDefaultNs(v as typeof defaultNs)}
                options={[
                  ["remember", "Remember per cluster"],
                  ["all", "All namespaces"],
                  ["default", "Context namespace"],
                ]}
              />
            </Setting>
          )}
          {show("hide system namespaces", "kube-system") && (
            <Setting label="Hide system namespaces" detail={<span className="font-mono">kube-system, kube-public, kube-node-lease</span>}>
              <Switch checked={hideSystem} onCheckedChange={setHideSystem} aria-label="Hide system namespaces" />
            </Setting>
          )}
        </Section>
      ),
    },
    {
      id: "tables",
      col: 0,
      node: (
        <Section id="tables" icon={<Columns3 />} title="Tables & columns">
          {show("hide columns", "narrow", "priority") && (
            <Setting label="Hide low-priority columns on narrow windows" detail="The footer names the hidden columns; the column menu brings them back.">
              <Switch checked={autoHideColumns} onCheckedChange={setAutoHideColumns} aria-label="Hide low-priority columns" />
            </Setting>
          )}
        </Section>
      ),
    },
    {
      id: "watch",
      col: 0,
      node: (
        <Section id="watch" icon={<RefreshCw />} title="Refresh & watch">
          {show("update method", "watch", "poll") && (
            <Setting label="Update method" detail="Watch streams changes; polling uses less API quota on very large clusters.">
              <Segmented
                aria-label="Update method"
                value={updateMethod}
                onValueChange={setUpdateMethod}
                options={[
                  { value: "watch", label: "Watch" },
                  { value: "poll", label: "Poll 30s" },
                ]}
              />
            </Setting>
          )}
          {show("pause watches in background tabs") && (
            <Setting label="Pause watches in background tabs" detail="After 5 minutes; resumes with a full re-list.">
              <Switch checked={pauseBackground} onCheckedChange={setPauseBackground} aria-label="Pause background watches" />
            </Setting>
          )}
          {show("metrics refresh", "metrics-server") && (
            <Setting label="Metrics refresh" detail="metrics-server reports current usage only; Clustrail keeps samples while it runs.">
              <NumberField label="Metrics refresh" value={metricsInterval} onChange={setMetricsInterval} min={10} max={300} unit="s" />
            </Setting>
          )}
        </Section>
      ),
    },
    {
      id: "perf",
      col: 1,
      node: (
        <Section
          id="perf"
          icon={<Cpu />}
          title="Memory & buffers"
          trailing={heap ? <span className="text-meta font-normal text-fg-muted">UI heap now {Math.round(heap / 1048576)} MB</span> : undefined}
        >
          {show("resource cache budget", "memory") && (
            <Setting
              label="Resource cache budget"
              detail={
                <span className="flex items-center gap-2">
                  <span className="font-mono">{cachedObjects.toLocaleString()} objects cached</span>
                </span>
              }
            >
              <NumberField label="Resource cache budget" value={cacheBudget} onChange={setCacheBudget} min={256} max={8192} unit="MB" />
            </Setting>
          )}
          {show("log buffer per stream", "lines") && (
            <Setting label="Log buffer per stream" detail="Oldest lines are dropped when full; the footer shows how many.">
              <NumberField label="Log buffer per stream" value={logBuffer} onChange={setLogBuffer} min={1000} max={1_000_000} />
            </Setting>
          )}
          {show("total log memory") && (
            <Setting
              label="Total log memory"
              detail={
                <span className="flex items-center gap-2">
                  <Meter value={Math.min(1, (logBuffer * 260) / 1048576 / logMemory)} label="Log buffer of one stream vs total" className="max-w-24" />
                  <span>one full stream ≈ {Math.round((logBuffer * 260) / 1048576)} MB</span>
                </span>
              }
            >
              <NumberField label="Total log memory" value={logMemory} onChange={setLogMemory} min={64} max={4096} unit="MB" />
            </Setting>
          )}
          {show("terminal scrollback") && (
            <Setting label="Terminal scrollback" detail="Lines kept per shell session.">
              <NumberField label="Terminal scrollback" value={scrollback} onChange={setScrollback} min={1000} max={100_000} />
            </Setting>
          )}
        </Section>
      ),
    },
    {
      id: "term",
      col: 1,
      node: (
        <Section id="term" icon={<SquareTerminal />} title="Logs & terminal">
          {show("timestamps", "logs") && (
            <Setting label="Show timestamps in new log views">
              <Switch checked={logTimestamps} onCheckedChange={setLogTimestamps} aria-label="Show timestamps" />
            </Setting>
          )}
          {show("wrap", "logs") && (
            <Setting label="Wrap long log lines">
              <Switch checked={logWrap} onCheckedChange={setLogWrap} aria-label="Wrap long lines" />
            </Setting>
          )}
        </Section>
      ),
    },
    {
      id: "helm",
      col: 1,
      node: <HelmRepos repos={repos} setRepos={setRepos} visible={show("helm", "repositories", "chart", ...repos.map((r) => r.name))} />,
    },
    {
      id: "keys",
      col: 1,
      node: show("keyboard shortcuts", "keys") ? (
        <Section id="keys" icon={<Keyboard />} title="Keyboard shortcuts">
          <Setting label="Shortcut reference" detail="⌘K opens the command palette from anywhere. Press ? for the full list.">
            <Button size="sm" onClick={openHelp}>
              Show all
            </Button>
          </Setting>
        </Section>
      ) : null,
    },
    {
      id: "privacy",
      col: 1,
      node: (
        <Section id="privacy" icon={<Shield />} title="Privacy & diagnostics">
          {show("usage telemetry", "privacy") && (
            <Setting label="Usage telemetry" detail={telemetry ? "On. Anonymous feature usage, no cluster names or resource data." : "Off. Clustrail sends nothing unless you turn this on."}>
              <Switch checked={telemetry} onCheckedChange={setTelemetry} aria-label="Usage telemetry" />
            </Setting>
          )}
          {show("crash reports") && (
            <Setting label="Crash reports">
              <Select
                label="Crash reports"
                value={crashReports}
                onChange={(v) => setCrashReports(v as typeof crashReports)}
                options={[
                  ["ask", "Ask each time"],
                  ["never", "Never send"],
                  ["always", "Send automatically"],
                ]}
              />
            </Setting>
          )}
          {show("diagnostics bundle") && (
            <Setting label="Diagnostics bundle" detail="Created locally with secrets and tokens redacted. You review it before sharing.">
              <Button size="sm" disabled title="Available in the desktop app">
                Create…
              </Button>
            </Setting>
          )}
        </Section>
      ),
    },
    {
      id: "updates",
      col: 1,
      node: show("updates", "version", "check") ? (
        <Section id="updates" icon={<Download />} title="Updates">
          <Setting label="Check for updates" detail="Release notes from github.com/mihnk/clustrail. Signed builds only.">
            <Select
              label="Check for updates"
              value={updateChannel}
              onChange={(v) => setUpdateChannel(v as typeof updateChannel)}
              options={[
                ["daily-stable", "Daily · Stable"],
                ["weekly-stable", "Weekly · Stable"],
                ["daily-beta", "Daily · Beta"],
                ["off", "Never"],
              ]}
            />
          </Setting>
          <Setting
            label={
              <span className="flex items-center gap-2">
                <StatusGlyph health={checking ? "progressing" : "completed"} className={checking ? undefined : "text-status-healthy"} />
                {checking ? "Checking…" : `Clustrail ${APP_VERSION} is up to date`}
              </span>
            }
            detail={checkedAt ? `Checked at ${checkedAt}` : undefined}
          >
            <Button size="sm" variant="ghost" onClick={checkUpdates} disabled={checking}>
              Check now
            </Button>
          </Setting>
        </Section>
      ) : null,
    },
    {
      id: "about",
      col: 1,
      node: show("about", "licenses", "version") ? (
        <Section id="about" icon={<Logo size={18} />} title="About Clustrail">
          <Setting label={`Version ${APP_VERSION} · Apache-2.0`} detail="Free and open source by mihnk. Every feature is free — no tiers, no account.">
            <Button size="sm" variant="ghost" onClick={() => window.open("https://github.com/mihnk/clustrail", "_blank", "noopener")}>
              <ExternalLink aria-hidden />
              github.com/mihnk/clustrail
            </Button>
          </Setting>
          <Setting label="Open-source licenses" detail="Go modules and npm packages bundled with this build.">
            <Button size="sm" disabled title="Generated into the desktop build">
              View
            </Button>
          </Setting>
        </Section>
      ) : null,
    },
  ];

  const visible = sections.filter((s) => s.node);
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside aria-label="Settings categories" className="flex w-[220px] shrink-0 flex-col gap-0.5 border-r border-line bg-surface-side px-2.5 py-3">
        <label className="mb-2 flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-surface-panel pl-2 pr-1.5 text-fg-muted focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
          <Search className="size-3.5 shrink-0" aria-hidden />
          <span className="sr-only">Search settings</span>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (query ? setQuery("") : e.currentTarget.blur())}
            placeholder="Search settings"
            spellCheck={false}
            className="min-w-0 flex-1 border-0 bg-transparent text-cell text-fg outline-none placeholder:text-fg-muted"
          />
        </label>
        <nav className="flex flex-col gap-0.5" aria-label="Categories">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => go(c)}
              aria-current={current === c.id ? "true" : undefined}
              className={cn(
                "focus-ring flex h-7 items-center gap-2 rounded-md border-0 bg-transparent px-2.5 text-left text-cell text-fg-secondary hover:bg-surface-hover hover:text-fg [&_svg]:size-3.5 [&_svg]:shrink-0",
                current === c.id && "bg-surface-panel font-medium text-fg shadow-[0_0_0_1px_var(--line)] hover:bg-surface-panel",
              )}
            >
              {c.icon}
              <span className="flex-1 truncate">{c.label}</span>
              {c.view && <ExternalLink className="text-fg-muted" aria-hidden />}
            </button>
          ))}
        </nav>
        <div className="flex-1" />
        <span className="text-meta text-fg-muted">
          Settings apply immediately and are stored locally in <span className="font-mono">~/.config/clustrail</span>.
        </span>
      </aside>

      <main ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4">
        {visible.length === 0 ? (
          <p className="text-cell text-fg-secondary">No settings match “{query}”.</p>
        ) : (
          <div className="grid grid-cols-2 items-start gap-4 max-[1360px]:grid-cols-1">
            {[0, 1].map((col) => (
              <div key={col} className="flex min-w-0 flex-col gap-4 max-[1360px]:contents">
                {visible.filter((s) => s.col === col).map((s) => (
                  <div key={s.id}>{s.node}</div>
                ))}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function Section({ id, icon, title, trailing, children }: { id: string; icon: ReactNode; title: string; trailing?: ReactNode; children: ReactNode }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  if (items.length === 0) return null;
  return (
    <section id={`settings-${id}`} aria-label={title} className="flex scroll-mt-4 flex-col rounded-[10px] border border-line bg-surface-panel">
      <h2 className="m-0 flex items-center gap-2 border-b border-line px-3.5 py-2.5 text-body font-semibold [&>svg]:size-4 [&>svg]:shrink-0">
        {icon}
        {title}
        <span className="flex-1" />
        {trailing}
      </h2>
      {items}
    </section>
  );
}

function Setting({ label, detail, children }: { label: ReactNode; detail?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-t border-line-row px-3.5 py-[9px] text-cell first-of-type:border-t-0">
      <div className="min-w-0">
        <div>{label}</div>
        {detail && <div className="mt-0.5 text-meta leading-[1.35] text-fg-muted">{detail}</div>}
      </div>
      {children}
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="focus-ring flex h-[26px] items-center gap-2 whitespace-nowrap rounded-md border border-line-strong bg-surface-panel pl-2 pr-1.5 text-ui text-fg"
        >
          {options.find(([v]) => v === value)?.[1] ?? value}
          <ChevronDown className="size-3.5 text-fg-muted" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map(([v, l]) => (
            <DropdownMenuRadioItem key={v} value={v}>
              {l}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Numeric setting: commits on Enter or blur, clamped to its range. */
function NumberField({ label, value, onChange, min, max, unit }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; unit?: string }) {
  const [draft, setDraft] = useState(value.toLocaleString("en-US"));
  useEffect(() => setDraft(value.toLocaleString("en-US")), [value]);
  const commit = () => {
    const n = Number(draft.replace(/[,\s]/g, ""));
    if (!Number.isFinite(n)) return setDraft(value.toLocaleString("en-US"));
    const clamped = Math.round(Math.min(max, Math.max(min, n)));
    onChange(clamped);
    setDraft(clamped.toLocaleString("en-US"));
  };
  return (
    <label className="flex h-[26px] w-[96px] items-center gap-1 rounded-md border border-line-strong bg-surface-panel px-2 font-mono text-ui focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
      <span className="sr-only">{label}</span>
      <input
        value={draft}
        inputMode="numeric"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        title={`${min.toLocaleString("en-US")}–${max.toLocaleString("en-US")}`}
        className="min-w-0 flex-1 border-0 bg-transparent text-right text-fg outline-none"
      />
      {unit && <span className="text-fg-muted">{unit}</span>}
    </label>
  );
}

function HelmRepos({ repos, setRepos, visible }: { repos: HelmRepo[]; setRepos: (r: HelmRepo[]) => void; visible: boolean }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  if (!visible) return null;
  const valid = /^[a-z0-9][a-z0-9-]*$/.test(name) && /^(https:\/\/|oci:\/\/)\S+$/.test(url) && !repos.some((r) => r.name === name);
  const field = "h-[26px] min-w-0 rounded-md border border-line-strong bg-surface-app px-2 text-ui text-fg outline-none placeholder:text-fg-muted focus:border-accent";
  return (
    <Section id="helm" icon={<LifeBuoy />} title="Helm repositories">
      {repos.map((r) => (
        <Setting key={r.name} label={<span className="font-mono">{r.name}</span>} detail={<span className="font-mono">{r.url}</span>}>
          <IconButton aria-label={`Remove ${r.name}`} onClick={() => setRepos(repos.filter((x) => x.name !== r.name))}>
            <Trash2 />
          </IconButton>
        </Setting>
      ))}
      {adding ? (
        <div className="flex items-center gap-1.5 border-t border-line-row px-3.5 py-2">
          <input aria-label="Repository name" value={name} onChange={(e) => setName(e.target.value)} placeholder="name" className={cn(field, "w-28 font-mono")} autoFocus />
          <input aria-label="Repository URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https:// or oci://" className={cn(field, "flex-1 font-mono")} />
          <Button
            size="sm"
            variant="primary"
            disabled={!valid}
            onClick={() => {
              setRepos([...repos, { name, url }]);
              setAdding(false);
              setName("");
              setUrl("");
            }}
          >
            Add
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Setting label="Charts that are not in a configured repository can be rolled back but not upgraded." detail="Credentials for private repositories are stored in the OS keychain.">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Add repository…
          </Button>
        </Setting>
      )}
    </Section>
  );
}
