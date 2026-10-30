import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ClipboardPaste,
  Copy,
  Eye,
  FileText,
  Home,
  Info,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Terminal,
  UserX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { Logo } from "@/components/shell/Logo";
import { useToast } from "@/components/ui/toast";
import { backendInfo, errorText, type SetupContext, type SetupInfo, type SetupTestResult } from "@/backend/client";
import type { Environment } from "@/data/types";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/cn";
import { t, tn } from "@/i18n";
import { setupApi } from "./api";

// First-run setup: find kubeconfig → choose contexts → environment and
// protection → connection test → the first workspace (tips, see SetupTips).

export interface SetupSummary {
  connected: number;
  protectedCount: number;
  /** Chosen contexts that did not connect. */
  attention: string[];
}

type Protection = "standard" | "protected" | "readonly";
type Step = 1 | 2 | 3 | 4;
interface TestState {
  running: boolean;
  result?: SetupTestResult;
  error?: string;
}

const STEP_LABELS = ["Find kubeconfig", "Choose contexts", "Environments & protection", "Test connections", "Start"] as const;

export function SetupFlow({ onDone, onSkip }: { onDone: (summary: SetupSummary) => void; onSkip: () => void }) {
  const api = useMemo(setupApi, []);
  const toast = useToast();
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [scanMs, setScanMs] = useState(0);
  const [step, setStep] = useState<Step>(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [envs, setEnvs] = useState<Record<string, Environment | "">>({});
  const [prot, setProt] = useState<Record<string, Protection>>({});
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [finishing, setFinishing] = useState(false);
  const initialized = useRef(false);

  const load = async () => {
    const started = performance.now();
    try {
      const next = await api.info();
      setScanMs(performance.now() - started);
      setInfo(next);
      // Defaults once, from the first answer that has contexts: what is known, else everything.
      if (!initialized.current && next.contexts.length > 0) {
        initialized.current = true;
        const known = next.contexts.filter((c) => c.known);
        setSelected(new Set((known.length ? known : next.contexts).map((c) => c.id)));
        setEnvs(Object.fromEntries(next.contexts.map((c) => [c.id, c.env])));
        setProt(Object.fromEntries(next.contexts.map((c) => [c.id, c.readOnly ? "readonly" : c.protected ? "protected" : "standard"])));
      }
    } catch (e) {
      toast.show({ kind: "error", title: t("Could not read kubeconfig files"), detail: errorText(e) });
    }
  };
  useEffect(() => void load(), []);
  // No kubeconfig yet: Go watches the files; pick up one created meanwhile.
  const empty = info !== null && info.contexts.length === 0;
  useEffect(() => {
    if (!empty) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [empty]);

  const chosen = (info?.contexts ?? []).filter((c) => selected.has(c.id));
  const needEnv = chosen.filter((c) => !envs[c.id]);
  const protectedCount = chosen.filter((c) => prot[c.id] !== "standard").length;

  const runTests = (ids: string[]) => {
    setTests((cur) => ({ ...cur, ...Object.fromEntries(ids.map((id) => [id, { running: true }])) }));
    for (const id of ids) {
      api.test(id).then(
        (result) => setTests((cur) => ({ ...cur, [id]: { running: false, result } })),
        (e) => setTests((cur) => ({ ...cur, [id]: { running: false, error: errorText(e) } })),
      );
    }
  };
  const goTest = () => {
    setStep(4);
    runTests(chosen.map((c) => c.id));
  };

  const connectedIds = chosen.filter((c) => tests[c.id]?.result?.state === "connected").map((c) => c.id);
  const testing = chosen.some((c) => tests[c.id]?.running);
  const finish = async () => {
    setFinishing(true);
    try {
      await api.complete(
        chosen.map((c) => ({ id: c.id, env: envs[c.id] as Environment, protected: prot[c.id] !== "standard", readOnly: prot[c.id] === "readonly" })),
        connectedIds,
      );
      await Promise.all(connectedIds.map((id) => api.connect(id)));
      onDone({ connected: connectedIds.length, protectedCount, attention: chosen.filter((c) => !connectedIds.includes(c.id)).map((c) => c.name) });
    } catch (e) {
      toast.show({ kind: "error", title: t("Could not save the setup"), detail: errorText(e) });
      setFinishing(false);
    }
  };
  const skip = () => void api.skip().then(onSkip, (e) => toast.show({ kind: "error", title: t("Could not skip setup"), detail: errorText(e) }));

  const files = (info?.locations ?? []).filter((l) => l.state === "found").length;
  const total = info?.contexts.length ?? 0;
  const subs: string[] = [
    total ? t(files === 1 ? "{contexts} contexts in 1 file" : "{contexts} contexts in {files} files", { contexts: total, files }) : "",
    t("{n} selected", { n: chosen.length }),
    protectedCount ? t("{n} protected", { n: protectedCount }) : t("none protected"),
    "",
    "",
  ];

  return (
    <div className="flex h-full flex-col bg-surface-app text-fg">
      <header className={cn("drag-region flex h-10 shrink-0 items-center justify-center border-b border-line bg-surface-side", isMac && "pl-[78px]")}>
        <span className="text-ui text-fg-muted">{t("Set up Clustrail")}</span>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label={t("Setup steps")} className="flex w-[280px] shrink-0 flex-col gap-[22px] border-r border-line bg-surface-side px-5 py-7">
          <div className="flex items-center gap-2.5">
            <Logo size={28} />
            <span className="text-[17px] font-semibold tracking-[-.02em]">clustrail</span>
          </div>
          <ol className="m-0 flex list-none flex-col gap-[18px] p-0">
            {STEP_LABELS.map((label, i) => {
              const n = i + 1;
              const done = n < step;
              const cur = n === step;
              return (
                <li key={label} className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-x-3 text-cell" aria-current={cur ? "step" : undefined}>
                  <span
                    className={cn(
                      "flex size-6 items-center justify-center rounded-full border font-mono text-[11.5px] font-semibold",
                      done ? "border-accent bg-accent text-accent-ink" : cur ? "border-accent text-accent shadow-[0_0_0_3px_var(--accent-soft)]" : "border-line-strong text-fg-muted",
                    )}
                  >
                    {done ? "✓" : n}
                  </span>
                  <span className="flex flex-col gap-0.5 pt-[3px]">
                    <span className={cn(cur ? "font-semibold text-fg" : done ? "text-fg-secondary" : "text-fg-muted")}>{t(label)}</span>
                    {done && subs[i] && <span className="text-meta text-fg-muted">{subs[i]}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
          <span className="flex-1" />
          <span className="text-meta leading-normal text-fg-muted">{t("You can change everything later in Connections. Setup can be run again from Settings.")}</span>
        </nav>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-16 pb-6 pt-11">
            {info === null ? (
              <p className="m-0 text-cell text-fg-muted">{t("Looking for kubeconfig files…")}</p>
            ) : empty ? (
              <NoKubeconfig info={info} onAdded={load} />
            ) : step === 1 ? (
              <FindStep info={info} scanMs={scanMs} onRescan={load} />
            ) : step === 2 ? (
              <ContextsStep contexts={info.contexts} selected={selected} setSelected={setSelected} />
            ) : step === 3 ? (
              <ProtectionStep
                contexts={chosen}
                envs={envs}
                prot={prot}
                setEnv={(id, env) => {
                  setEnvs((cur) => ({ ...cur, [id]: env }));
                  // A new environment brings its default protection; read-only stays.
                  setProt((cur) => (cur[id] === "readonly" ? cur : { ...cur, [id]: env === "prod" ? "protected" : "standard" }));
                }}
                setProtection={(id, p) => setProt((cur) => ({ ...cur, [id]: p }))}
              />
            ) : (
              <TestStep contexts={chosen} envs={envs} tests={tests} onRetry={(ids) => runTests(ids)} />
            )}
          </div>

          <footer className="flex h-16 shrink-0 items-center gap-2.5 border-t border-line bg-surface-panel pl-16 pr-6">
            {step > 1 && !empty && (
              <Button variant="ghost" size="lg" onClick={() => setStep((s) => (s - 1) as Step)}>
                <ArrowLeft aria-hidden />
                {t("Back")}
              </Button>
            )}
            {step < 4 && (
              <Button variant="ghost" size="lg" onClick={skip}>
                {empty ? t("Skip — open an empty workspace") : t("Skip setup")}
              </Button>
            )}
            <span className="flex-1" />
            {step === 3 && needEnv.length > 0 && (
              <span className="flex items-center gap-1.5 text-cell text-status-warning">
                <StatusGlyph health="warning" />
                {needEnv.length === 1 ? t("1 context needs an environment") : t("{n} contexts need an environment", { n: needEnv.length })}
              </span>
            )}
            {step === 4 && <span className="text-meta text-fg-muted">{t("Failed contexts are kept and marked. Fix them anytime in Connections.")}</span>}
            <span className="text-meta text-fg-muted">{t("Step {n} of 5", { n: empty ? 1 : step })}</span>
            {step === 1 && (
              <Button variant="primary" size="lg" disabled={empty || info === null} onClick={() => setStep(2)}>
                {t("Choose contexts")}
                <ArrowRight aria-hidden />
              </Button>
            )}
            {step === 2 && (
              <Button variant="primary" size="lg" disabled={chosen.length === 0} onClick={() => setStep(3)}>
                {t("Set up protection")}
                <ArrowRight aria-hidden />
              </Button>
            )}
            {step === 3 && (
              <Button variant="primary" size="lg" disabled={needEnv.length > 0} onClick={goTest}>
                {t("Test connections")}
                <ArrowRight aria-hidden />
              </Button>
            )}
            {step === 4 && (
              <Button variant="primary" size="lg" disabled={testing || finishing} onClick={() => void finish()}>
                {testing
                  ? t("Testing…")
                  : connectedIds.length === 0
                    ? t("Finish without connecting")
                    : t("Finish with {n} connected", { n: connectedIds.length })}
                <ArrowRight aria-hidden />
              </Button>
            )}
          </footer>
        </main>
      </div>
      <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-surface-side px-3 text-meta text-fg-muted">
        <span>{t("Clustrail {version} · Apache-2.0", { version: backendInfo?.version ?? "0.9.0" })}</span>
        <span className="flex-1" />
        {step >= 3 && protectedCount > 0 && (
          <span className="flex items-center gap-1.5 text-env-prod-ink">
            <Lock className="size-3" aria-hidden />
            {protectedCount === 1 ? t("1 context will be protected") : t("{n} contexts will be protected", { n: protectedCount })}
          </span>
        )}
        {!backendInfo && <span className="rounded border border-line-strong px-1.5 font-mono text-2xs tracking-[.05em]">{t("MOCK DATA")}</span>}
      </footer>
    </div>
  );
}

function Heading({ title, lead }: { title: string; lead: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <h1 className="m-0 text-[24px] font-semibold tracking-[-.02em]">{title}</h1>
      <p className="m-0 max-w-[680px] text-body leading-normal text-fg-secondary">{lead}</p>
    </div>
  );
}

const panel = "overflow-hidden rounded-[10px] border border-line bg-surface-panel";
const sectionLabel = "text-label font-semibold uppercase tracking-[.06em] text-fg-muted";

/* 1 · Find kubeconfig */

function FindStep({ info, scanMs, onRescan }: { info: SetupInfo; scanMs: number; onRescan: () => void }) {
  const found = info.locations.filter((l) => l.state === "found" || l.state === "invalid");
  const files = info.locations.filter((l) => l.state === "found").length;
  return (
    <>
      <Heading title={t("Welcome to Clustrail")} lead={t("Let’s connect your clusters. Clustrail uses the kubeconfig files you already have — this takes about a minute.")} />
      <div className="grid max-w-[960px] grid-cols-3 gap-3">
        <PromiseCard icon={<Home />} title={t("Runs on this machine.")} text={t("Talks directly to your API servers. No Clustrail server in between.")} />
        <PromiseCard icon={<UserX />} title={t("No account.")} text={t("No sign-in, no email, no telemetry. Every feature is free.")} />
        <PromiseCard icon={<KeyRound />} title={t("Credentials stay put.")} text={t("Kubeconfig is read in place; tokens are never copied or stored.")} />
      </div>
      <section className="flex max-w-[960px] flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <span className={cn(sectionLabel, "flex-1")}>{t("Found on this machine")}</span>
          <span className="text-meta text-fg-muted">
            {t(files === 1 ? "{contexts} contexts in 1 file · scanned in {seconds}s" : "{contexts} contexts in {files} files · scanned in {seconds}s", {
              contexts: info.contexts.length,
              files,
              seconds: (scanMs / 1000).toFixed(1),
            })}
          </span>
          <Button variant="ghost" size="sm" onClick={onRescan}>
            <RefreshCw aria-hidden />
            {t("Scan again")}
          </Button>
        </div>
        <div className={panel} role="table" aria-label={t("Kubeconfig files")}>
          <div role="row" className="grid h-8 grid-cols-[18px_minmax(0,1fr)_150px_120px] items-center gap-x-3 px-3.5 text-meta text-fg-muted">
            <span />
            <span role="columnheader">{t("File")}</span>
            <span role="columnheader">{t("Found via")}</span>
            <span role="columnheader">{t("Contexts")}</span>
          </div>
          {found.map((l) => (
            <div key={l.path} role="row" className="grid h-11 grid-cols-[18px_minmax(0,1fr)_150px_120px] items-center gap-x-3 border-t border-line-row px-3.5 text-cell">
              <StatusGlyph health={l.state === "found" ? "completed" : "warning"} className={l.state === "found" ? "text-status-healthy" : undefined} />
              <span className="truncate">
                <span className="font-mono">{l.path}</span>
                {l.state === "invalid" && <span className="text-status-warning"> {t("skipped — {error}", { error: shortError(l.error) })}</span>}
              </span>
              <span className="text-fg-secondary">{l.via === "env" ? <span className="font-mono">$KUBECONFIG</span> : l.via === "added" ? t("added in Clustrail") : t("default location")}</span>
              <span className={cn("font-mono", l.state !== "found" && "text-fg-muted")}>{l.state === "found" ? l.contexts : "—"}</span>
            </div>
          ))}
        </div>
      </section>
      <AddFile onAdded={onRescan} />
    </>
  );
}

function shortError(e?: string) {
  if (!e) return t("unreadable");
  const line = /line (\d+)/.exec(e);
  return line ? t("invalid YAML at line {line}", { line: line[1] }) : e.length > 80 ? `${e.slice(0, 80)}…` : e;
}

function PromiseCard({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="flex gap-2.5 rounded-[10px] border border-line bg-surface-panel p-3 text-[12.5px] leading-[1.45]">
      <span className="text-accent [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      <span>
        <b className="font-semibold">{title}</b> <span className="text-fg-secondary">{text}</span>
      </span>
    </div>
  );
}

function AddFile({ onAdded }: { onAdded: () => void }) {
  const api = useMemo(setupApi, []);
  const toast = useToast();
  const choose = () =>
    api.addFile().then(
      (path) => path && onAdded(),
      (e) => toast.show({ kind: "error", title: t("Could not add the file"), detail: errorText(e) }),
    );
  return (
    <div className="flex max-w-[960px] items-center gap-3 rounded-[10px] border border-dashed border-line-strong p-3.5 text-[12.5px] text-fg-secondary">
      <FileText className="size-4 text-fg-muted" aria-hidden />
      <span className="flex-1">{t("Have another kubeconfig? Choose the file. It is used in place, not copied.")}</span>
      <Button size="sm" onClick={() => void choose()}>
        <Plus aria-hidden />
        {t("Choose file…")}
      </Button>
    </div>
  );
}

/* 1 · No kubeconfig yet */

const CLI: { id: string; label: string; command: string }[] = [
  { id: "eks", label: "AWS EKS", command: "aws eks update-kubeconfig \\\n  --name CLUSTER_NAME --region REGION" },
  { id: "gke", label: "GKE", command: "gcloud container clusters get-credentials CLUSTER_NAME \\\n  --region REGION --project PROJECT_ID" },
  { id: "aks", label: "AKS", command: "az aks get-credentials \\\n  --resource-group RESOURCE_GROUP --name CLUSTER_NAME" },
  { id: "kind", label: "kind", command: "kind create cluster --name local" },
];

function NoKubeconfig({ info, onAdded }: { info: SetupInfo; onAdded: () => void }) {
  const api = useMemo(setupApi, []);
  const toast = useToast();
  const [cli, setCli] = useState("eks");
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const [pasteError, setPasteError] = useState("");
  const command = CLI.find((c) => c.id === cli)!.command;
  const savePaste = () =>
    api.paste(text).then(
      (path) => {
        toast.show({ kind: "success", title: t("Kubeconfig saved"), target: path });
        setPasting(false);
        setText("");
        onAdded();
      },
      (e) => setPasteError(errorText(e)),
    );
  return (
    <>
      <Heading title={t("No kubeconfig found yet")} lead={tn("Clustrail connects with a kubeconfig file, the same one {kubectl} uses. Add one below, or create it with your cloud’s CLI.", { kubectl: <span className="font-mono">kubectl</span> })} />
      <div className="flex max-w-[640px] flex-col">
        <span className={cn(sectionLabel, "pb-1")}>{t("Where we looked")}</span>
        {info.locations.map((l) => (
          <div key={l.path} className="grid h-[30px] grid-cols-[16px_220px_minmax(0,1fr)] items-center gap-x-2.5 text-[12.5px]">
            <StatusGlyph health={l.state === "invalid" ? "warning" : "unknown"} />
            <span className="truncate font-mono">{l.path}</span>
            <span className="truncate text-fg-secondary">
              {l.state === "unset" ? t("not set for this app") : l.state === "missing" ? t("does not exist") : l.state === "invalid" ? shortError(l.error) : t("{n} contexts", { n: l.contexts })}
            </span>
          </div>
        ))}
        <div className="grid h-[30px] grid-cols-[16px_220px_minmax(0,1fr)] items-center gap-x-2.5 text-[12.5px]">
          <StatusGlyph health="progressing" />
          <span className="font-mono">~/.kube/</span>
          <span className="text-fg-secondary">{t("watching — setup continues automatically when a kubeconfig appears")}</span>
        </div>
      </div>
      <div className="grid max-w-[1080px] grid-cols-[1fr_1fr_1.6fr] items-start gap-3.5">
        <Option icon={<FileText />} title={t("Choose a file")} text={t("Used in place, not copied. Add more later in Connections.")}>
          <AddFileButton onAdded={onAdded} />
        </Option>
        <Option
          icon={<ClipboardPaste />}
          title={t("Paste a kubeconfig")}
          text={tn("Saved as {path} with owner-only permissions (0600).", { path: <span className="font-mono">~/.kube/clustrail-pasted.yaml</span> })}
        >
          {pasting ? (
            <div className="flex flex-col gap-2">
              <textarea
                autoFocus
                aria-label={t("Kubeconfig YAML")}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setPasteError("");
                }}
                spellCheck={false}
                className="focus-ring h-32 resize-none rounded-md border border-line-strong bg-surface-app p-2 font-mono text-meta text-fg"
              />
              {pasteError && <span className="text-meta text-status-critical">{pasteError}</span>}
              <div className="flex gap-1.5">
                <Button size="sm" variant="primary" disabled={!text.trim()} onClick={() => void savePaste()}>
                  {t("Save")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPasting(false)}>
                  {t("Cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <Button className="self-start" onClick={() => setPasting(true)}>
              {t("Paste…")}
            </Button>
          )}
        </Option>
        <Option icon={<Terminal />} title={t("Create one with your cloud CLI")}>
          <div role="tablist" aria-label={t("Cloud")} className="flex gap-0.5 border-b border-line">
            {CLI.map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={c.id === cli}
                onClick={() => setCli(c.id)}
                className={cn("focus-ring h-[30px] border-0 bg-transparent px-2.5 text-cell font-medium", c.id === cli ? "text-fg shadow-[inset_0_-2px_0_var(--accent)]" : "text-fg-muted")}
              >
                {c.label}
              </button>
            ))}
          </div>
          <pre className="selectable m-0 whitespace-pre rounded-lg border border-line bg-term-bg px-3 py-2.5 font-mono text-[12.5px] leading-5 text-term-fg">{command}</pre>
          <div className="flex items-center gap-1.5">
            <Button size="sm" onClick={() => void navigator.clipboard?.writeText(command.replace(/\\\n\s*/g, ""))}>
              <Copy aria-hidden />
              {t("Copy")}
            </Button>
            <span className="text-meta text-fg-muted">{t("Run it in your terminal. Clustrail picks up the new file on its own.")}</span>
          </div>
        </Option>
      </div>
    </>
  );
}

function AddFileButton({ onAdded }: { onAdded: () => void }) {
  const api = useMemo(setupApi, []);
  const toast = useToast();
  return (
    <Button
      className="self-start"
      onClick={() =>
        void api.addFile().then(
          (path) => path && onAdded(),
          (e) => toast.show({ kind: "error", title: t("Could not add the file"), detail: errorText(e) }),
        )
      }
    >
      {t("Choose kubeconfig…")}
    </Button>
  );
}

function Option({ icon, title, text, children }: { icon: ReactNode; title: string; text?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-line bg-surface-panel p-4 text-[12.5px]">
      <span className="flex items-center gap-2">
        <span className="text-accent [&_svg]:size-4" aria-hidden>
          {icon}
        </span>
        <b className="font-semibold">{title}</b>
      </span>
      {text && <span className="text-fg-secondary">{text}</span>}
      {children}
    </div>
  );
}

/* 2 · Choose contexts */

function ContextsStep({ contexts, selected, setSelected }: { contexts: SetupContext[]; selected: Set<string>; setSelected: (s: Set<string>) => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = contexts.filter((c) => !q || `${c.name} ${c.cluster} ${c.server}`.toLowerCase().includes(q));
  const all = shown.length > 0 && shown.every((c) => selected.has(c.id));
  const some = shown.some((c) => selected.has(c.id));
  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(selected);
    for (const id of ids) on ? next.add(id) : next.delete(id);
    setSelected(next);
  };
  const cols = "grid-cols-[20px_minmax(0,1fr)_260px_130px_170px]";
  return (
    <>
      <Heading title={t("Which clusters do you work with?")} lead={t("Pick the contexts Clustrail should show. Nothing connects yet — that happens in step 4, after you’ve set protection.")} />
      <div className="flex max-w-[1080px] items-center gap-2">
        <label className="flex h-7 w-[260px] items-center gap-1.5 rounded-md border border-line-strong bg-surface-panel px-2 text-fg-muted">
          <Search className="size-3.5" aria-hidden />
          <input
            aria-label={t("Filter contexts")}
            placeholder={t("Filter contexts…")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 border-0 bg-transparent text-cell text-fg outline-none placeholder:text-fg-muted"
          />
        </label>
        <Button variant="ghost" size="sm" onClick={() => toggle(shown.map((c) => c.id), true)}>
          {t("Select all")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => toggle(shown.map((c) => c.id), false)}>
          {t("None")}
        </Button>
        <span className="flex-1" />
        <b className="text-[12.5px] font-semibold">{t("{n} of {total} selected", { n: selected.size, total: contexts.length })}</b>
      </div>
      <div className={cn(panel, "max-w-[1080px]")} role="table" aria-label={t("Contexts")}>
        <div role="row" className={cn("grid h-8 items-center gap-x-3 px-3.5 text-meta text-fg-muted", cols)}>
          <Checkbox aria-label={t("Select all")} checked={all ? true : some ? "indeterminate" : false} onCheckedChange={(on) => toggle(shown.map((c) => c.id), on)} />
          <span role="columnheader">{t("Context")}</span>
          <span role="columnheader">{t("API server")}</span>
          <span role="columnheader">{t("Auth")}</span>
          <span role="columnheader">{t("Source")}</span>
        </div>
        {shown.map((c) => (
          <div key={c.id} role="row" className={cn("grid h-11 items-center gap-x-3 border-t border-line-row px-3.5", cols, !selected.has(c.id) && "opacity-60")}>
            <Checkbox aria-label={t("Include {name}", { name: c.name })} checked={selected.has(c.id)} onCheckedChange={(on) => toggle([c.id], on)} />
            <span className="flex min-w-0 flex-col gap-[3px]">
              <span className="flex items-center gap-2">
                <span className="truncate font-mono text-cell font-medium">{c.name}</span>
                {c.current && <span className="rounded bg-status-progressing-soft px-1.5 py-px text-2xs text-status-progressing">current-context</span>}
              </span>
              <span className="truncate text-meta text-fg-muted">{c.cluster}</span>
            </span>
            <span className="truncate font-mono text-[11.5px]">{c.server}</span>
            <span className="truncate font-mono text-[11.5px]">{c.auth}</span>
            <span className="truncate font-mono text-meta text-fg-muted">{c.source}</span>
          </div>
        ))}
      </div>
      <div className="flex max-w-[720px] items-center gap-2.5 rounded-lg bg-status-progressing-soft px-2.5 py-2 text-cell">
        <Info className="size-3.5 shrink-0 text-status-progressing" aria-hidden />
        <span>{t("Unselected contexts stay in your kubeconfig and appear later in Connections as available. Clustrail never edits kubeconfig files.")}</span>
      </div>
    </>
  );
}

/* 3 · Environments and protection */

const ENV_ORDER: Environment[] = ["prod", "stg", "dev"];

function hintText(c: SetupContext) {
  if (c.stored) return t("saved setting");
  if (!c.hint) return t("no environment word in context, cluster or server name — choose one");
  const field = c.hint.field === "context" ? t("context name") : c.hint.field === "cluster" ? t("cluster name") : t("server address");
  return t("suggested · “{word}” in {field}", { word: c.hint.word, field });
}

function ProtectionStep({
  contexts,
  envs,
  prot,
  setEnv,
  setProtection,
}: {
  contexts: SetupContext[];
  envs: Record<string, Environment | "">;
  prot: Record<string, Protection>;
  setEnv: (id: string, env: Environment) => void;
  setProtection: (id: string, p: Protection) => void;
}) {
  const cols = "grid-cols-[minmax(0,1fr)_196px_170px]";
  return (
    <>
      <Heading title={t("Mark your production clusters")} lead={t("Clustrail colors every screen by environment and protects production from accidental changes. We guessed from the names — please check.")} />
      <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-6">
        <div className={panel} role="table" aria-label={t("Environments and protection")}>
          <div role="row" className={cn("grid h-8 items-center gap-x-3 px-3.5 text-meta text-fg-muted", cols)}>
            <span role="columnheader">{t("Context")}</span>
            <span role="columnheader">{t("Environment")}</span>
            <span role="columnheader">{t("Protection")}</span>
          </div>
          {contexts.map((c) => {
            const env = envs[c.id];
            return (
              <div key={c.id} role="row" className={cn("grid min-h-[52px] items-center gap-x-3 border-t border-line-row px-3.5 py-[7px]", cols, !env && "bg-status-warning-soft")}>
                <span className="flex min-w-0 flex-col gap-[3px]">
                  <span className="truncate font-mono text-cell font-medium">{c.name}</span>
                  <span className={cn("truncate text-meta", env ? "text-fg-muted" : "text-status-warning")}>{hintText(c)}</span>
                </span>
                <span role="radiogroup" aria-label={t("Environment for {name}", { name: c.name })} className="inline-flex gap-1">
                  {ENV_ORDER.map((e) => (
                    <button
                      key={e}
                      type="button"
                      role="radio"
                      aria-checked={env === e}
                      onClick={() => setEnv(c.id, e)}
                      className={cn(
                        "focus-ring h-6 rounded-[5px] border bg-transparent px-2 font-mono text-[10.5px] font-semibold tracking-[.05em] text-fg-muted",
                        !env && "border-dashed border-status-warning",
                        env && env !== e && "border-line-strong",
                        env === e && e === "prod" && "border-env-prod bg-env-prod-soft text-env-prod-ink",
                        env === e && e === "stg" && "border-env-stg text-env-stg",
                        env === e && e === "dev" && "border-fg-muted bg-surface-hover text-fg",
                      )}
                    >
                      {e === "prod" ? "PROD" : e === "stg" ? "STG" : "DEV"}
                    </button>
                  ))}
                </span>
                {env ? (
                  <select
                    aria-label={t("Protection for {name}", { name: c.name })}
                    value={prot[c.id]}
                    onChange={(e) => setProtection(c.id, e.target.value as Protection)}
                    className={cn("focus-ring h-[26px] w-full rounded-md border border-line-strong bg-surface-panel px-1.5 text-ui", prot[c.id] !== "standard" ? "text-env-prod-ink" : "text-fg")}
                  >
                    <option value="standard">{t("Standard")}</option>
                    <option value="protected">{t("Protected")}</option>
                    <option value="readonly">{t("Read-only")}</option>
                  </select>
                ) : (
                  <span className="text-ui text-fg-muted">{t("Choose environment first")}</span>
                )}
              </div>
            );
          })}
        </div>
        <aside aria-label={t("Protection levels")} className="flex flex-col rounded-[10px] border border-line bg-surface-panel p-3.5">
          <span className={cn(sectionLabel, "pb-1.5")}>{t("Protection levels")}</span>
          <Level icon={<Shield className="text-fg-secondary" />} title={t("Standard")} text={t("Destructive actions ask once. Good for staging and dev.")} first />
          <Level icon={<Lock className="text-env-prod-ink" />} title={t("Protected")} text={t("Every change and every shell shows its impact and needs the resource name typed. Default for production.")} />
          <Level icon={<Eye />} title={t("Read-only")} text={t("Changes and shell are blocked in Clustrail. Logs, YAML and investigation still work.")} />
          <div className="mt-2.5 rounded-lg bg-status-progressing-soft px-2.5 py-2 text-ui">{t("This is a safety net inside Clustrail, not access control. What you can actually do is still decided by your cluster’s RBAC.")}</div>
        </aside>
      </div>
    </>
  );
}

function Level({ icon, title, text, first }: { icon: ReactNode; title: string; text: string; first?: boolean }) {
  return (
    <div className={cn("grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5 py-2.5 text-[12.5px] [&_svg]:mt-px [&_svg]:size-3.5", !first && "border-t border-line-row")}>
      <span aria-hidden>{icon}</span>
      <span className="flex flex-col gap-[3px]">
        <b className="font-semibold">{title}</b>
        <span className="text-fg-secondary">{text}</span>
      </span>
    </div>
  );
}

/* 4 · Connection test */

const CHIP: Record<string, string> = { DNS: "DNS", TLS: "TLS", Authentication: "Auth", "API discovery": "API", Permissions: "RBAC" };
const chipLabel = (name: string) => CHIP[name] ?? (name.startsWith("TCP") ? "TCP" : name);
const PENDING_STEPS = ["DNS", "TCP", "TLS", "Authentication", "API discovery", "Permissions"];

function TestStep({ contexts, envs, tests, onRetry }: { contexts: SetupContext[]; envs: Record<string, Environment | "">; tests: Record<string, TestState>; onRetry: (ids: string[]) => void }) {
  const state = (id: string) => (tests[id]?.running ? "running" : (tests[id]?.result?.state ?? (tests[id]?.error ? "failed" : "running")));
  const connected = contexts.filter((c) => state(c.id) === "connected").length;
  const running = contexts.filter((c) => state(c.id) === "running").length;
  const failedIds = contexts.filter((c) => !["connected", "running"].includes(state(c.id))).map((c) => c.id);
  return (
    <>
      <Heading title={t("Testing connections")} lead={t("Each context is checked in parallel. This is the first time Clustrail runs your auth plugins; nothing is changed in any cluster.")} />
      <div className="flex items-center gap-2" role="status">
        <Summary health="completed" className="text-status-healthy" text={t("{n} connected", { n: connected })} />
        {running > 0 && <Summary health="progressing" text={t("{n} testing", { n: running })} />}
        {failedIds.length > 0 && <Summary health="failed" text={t("{n} failed", { n: failedIds.length })} />}
        <span className="flex-1" />
        <Button size="sm" disabled={failedIds.length === 0} onClick={() => onRetry(failedIds)}>
          <RefreshCw aria-hidden />
          {t("Retry failed")}
        </Button>
      </div>
      <div className={panel} role="table" aria-label={t("Connection tests")}>
        <div role="row" className="grid grid-cols-[220px_330px_minmax(0,1fr)] items-start gap-x-[18px] px-4 py-2 text-meta text-fg-muted">
          <span role="columnheader">{t("Context")}</span>
          <span role="columnheader">DNS · TCP · TLS · Auth · API · RBAC</span>
          <span role="columnheader">{t("Result")}</span>
        </div>
        {contexts.map((c) => {
          const tst = tests[c.id];
          const steps = tst?.result?.steps ?? PENDING_STEPS.map((name) => ({ name, result: "skipped" as const, detail: "" }));
          const failedAt = steps.findIndex((s) => s.result === "failed");
          return (
            <div key={c.id} role="row" className="grid grid-cols-[220px_330px_minmax(0,1fr)] items-start gap-x-[18px] border-t border-line-row px-4 py-3 text-[12.5px]">
              <span className="flex min-w-0 items-center gap-2">
                {envs[c.id] && <EnvironmentBadge env={envs[c.id] as Environment} />}
                <span className="truncate font-mono font-medium">{c.name}</span>
              </span>
              <span className="flex gap-1">
                {steps.map((s, i) => (
                  <span
                    key={s.name}
                    className={cn(
                      "inline-flex h-[22px] items-center rounded px-1.5 font-mono text-[10.5px] font-medium",
                      tst?.running && i === 0 ? "border border-dashed border-status-progressing text-status-progressing" : "",
                      s.result === "ok" && "bg-status-healthy-soft text-status-healthy",
                      s.result === "failed" && "border border-status-critical bg-status-critical-soft text-status-critical",
                      s.result === "skipped" && !(tst?.running && i === 0) && "border border-line-strong text-fg-muted",
                    )}
                    title={s.detail || undefined}
                  >
                    {chipLabel(s.name)}
                  </span>
                ))}
              </span>
              <Result c={c} tst={tst} failedAt={failedAt} />
            </div>
          );
        })}
      </div>
    </>
  );
}

function Summary({ health, text, className }: { health: "completed" | "progressing" | "failed"; text: string; className?: string }) {
  return (
    <span className="flex h-[30px] items-center gap-2 rounded-full border border-line bg-surface-panel px-3 text-[12.5px]">
      <StatusGlyph health={health} className={className} />
      {text}
    </span>
  );
}

function Result({ c, tst, failedAt }: { c: SetupContext; tst?: TestState; failedAt: number }) {
  if (!tst || tst.running) return <span className="text-fg-muted">{t("Testing…")}</span>;
  if (tst.error) return <span className="text-status-critical">{tst.error}</span>;
  const r = tst.result!;
  const detail = (name: string) => r.steps.find((s) => s.name === name)?.detail ?? "";
  if (r.state === "connected") {
    const api = r.steps.find((s) => s.name === "API discovery");
    const tcp = r.steps.find((s) => s.name.startsWith("TCP"));
    return (
      <span className="flex flex-col gap-0.5">
        <span>{t("Connected · {version} · {ms}ms", { version: (api?.detail ?? "").split(" · ")[0], ms: tcp?.ms ?? 0 })}</span>
        <span className="text-meta text-fg-muted">{tn("as {identity}", { identity: <span className="font-mono">{detail("Authentication")}</span> })}</span>
      </span>
    );
  }
  const failed = r.steps[failedAt];
  if (r.state === "auth") {
    return (
      <span className="flex flex-col gap-1.5">
        <span>
          <b className="font-semibold text-status-critical">{t("Credentials expired")}</b>{" "}
          <span className="text-fg-secondary">{r.hint ? t("— run in your terminal, then retry:") : `— ${failed?.detail ?? ""}`}</span>
        </span>
        {r.hint && <CopyCommand command={r.hint} />}
      </span>
    );
  }
  if (r.state === "unreachable") {
    const local = /127\.0\.0\.1|localhost|\[::1\]/.test(c.server);
    return (
      <span className="flex flex-col gap-0.5">
        <span>
          <b className="font-semibold text-status-critical">{t("Unreachable")}</b> <span className="text-fg-secondary">— {failed?.detail}</span>
        </span>
        {local && <span className="text-meta text-fg-muted">{t("A local cluster is probably stopped. Start it, then retry.")}</span>}
      </span>
    );
  }
  return (
    <span>
      <b className="font-semibold text-status-critical">{t("Failed at {step}", { step: failed ? chipLabel(failed.name) : "?" })}</b> <span className="text-fg-secondary">— {failed?.detail}</span>
    </span>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex items-center gap-1.5 self-start rounded-md border border-line bg-surface-app py-1 pl-2 pr-1">
      <code className="selectable font-mono text-ui">{command}</code>
      <button
        type="button"
        aria-label={t("Copy command")}
        className="focus-ring inline-flex size-[22px] items-center justify-center rounded border-0 bg-transparent text-fg-muted hover:text-fg"
        onClick={() => void navigator.clipboard?.writeText(command).then(() => setCopied(true))}
      >
        {copied ? <StatusGlyph health="completed" className="text-status-healthy" /> : <Copy className="size-3" aria-hidden />}
      </button>
    </span>
  );
}
