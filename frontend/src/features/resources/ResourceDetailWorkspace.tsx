import { useEffect, useMemo, useState } from "react";
import { Code, Layers } from "lucide-react";
import { useWorkspace, type WorkspaceTab } from "@/app/workspace";
import { backend, errorText } from "@/backend/client";
import { useEvents } from "@/backend/hooks";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabCount } from "@/components/ui/tabs";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { EmptyState } from "@/components/EmptyState";
import { DeploymentInspector, type DeploymentTab } from "@/features/deployments/DeploymentInspector";
import { deploymentActions } from "@/features/deployments/actions";
import { useDeploymentDeps, type DeploymentNav } from "@/features/deployments/DeploymentsWorkspace";
import { EventsPanel } from "@/features/pods/PodInspector";
import { kindName } from "./kinds";
import { SecretKeys } from "./SecretKeys";

/** One object in its own tab: the full Deployment inspector, or YAML and events for any other kind. */
export function ResourceDetailWorkspace({ tab }: { tab: WorkspaceTab; active: boolean }) {
  const kind = tab.params?.kind ?? tab.subtitle ?? "";
  if (kindName(kind) === "Deployment") return <DeploymentDetail tab={tab} />;
  return <GenericDetail tab={tab} kind={kind} />;
}

function DeploymentDetail({ tab }: { tab: WorkspaceTab }) {
  const ws = useWorkspace();
  const ns = tab.params?.namespace ?? "";
  const name = tab.params?.name ?? tab.title;
  const d = ws.deployments.find((x) => x.cluster === tab.cluster && x.name === name && (!ns || x.namespace === ns));
  const [section, setSection] = useState<DeploymentTab>("overview");
  const [scaleFocusSeq, setScaleFocusSeq] = useState(0);
  const nav = useMemo<DeploymentNav>(
    () => ({
      showHistory: () => setSection("history"),
      focusScale: () => {
        setSection("overview");
        setScaleFocusSeq((n) => n + 1);
      },
    }),
    [],
  );
  const depsFor = useDeploymentDeps(nav);
  if (!d) {
    return (
      <EmptyState className="flex-1" icon={<Layers />} title={`${name} · Deployment`}>
        {ws.clusterById(tab.cluster ?? "")?.connection === "connected"
          ? `Not found in ${ns || "any namespace"} on ${tab.cluster}. It may have been deleted.`
          : `Connect ${tab.cluster} to see this Deployment.`}
      </EmptyState>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 justify-center bg-surface-app">
      <div className="flex min-h-0 w-full max-w-[880px] flex-col border-x border-line bg-surface-panel">
        <DeploymentInspector
          d={d}
          cluster={ws.clusterById(d.cluster)}
          actions={deploymentActions(d, depsFor(d))}
          tab={section}
          onTabChange={setSection}
          scaleFocusSeq={scaleFocusSeq}
          onClose={() => ws.closeTab(tab.id)}
        />
      </div>
    </div>
  );
}

function GenericDetail({ tab, kind }: { tab: WorkspaceTab; kind: string }) {
  const ws = useWorkspace();
  const cluster = ws.clusterById(tab.cluster ?? "");
  const ns = tab.params?.namespace ?? "";
  const name = tab.params?.name ?? tab.title;
  const [yaml, setYaml] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ type: string; keys: { key: string; bytes: number }[] } | undefined>();
  const [error, setError] = useState<string | null>(null);
  const events = useEvents(tab.cluster ?? "", ns, kindName(kind), name, !!backend);
  useEffect(() => {
    if (!backend || !tab.cluster) return;
    let cancelled = false;
    backend
      .getObject(tab.cluster, kind, ns, name)
      .then((o) => {
        if (cancelled) return;
        setYaml(o.yaml);
        setSecret(o.secret);
      })
      .catch((e) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [tab.id]);
  if (!backend) {
    return (
      <EmptyState className="flex-1" icon={<Layers />} title={`${name} · ${kindName(kind)}`}>
        Object details read the cluster’s API server, so they need the desktop app.
      </EmptyState>
    );
  }
  const params = { kind, namespace: ns, name };
  return (
    <div className="flex min-h-0 flex-1 justify-center bg-surface-app">
      <div className="flex min-h-0 w-full max-w-[880px] flex-col border-x border-line bg-surface-panel">
        <div className="flex flex-col gap-2 border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            {cluster && <EnvironmentBadge env={cluster.env} />}
            <span className="truncate font-mono text-title font-semibold">{name}</span>
            <div className="flex-1" />
            <Button onClick={() => ws.openView({ kind: "yaml", title: `YAML · ${name}`, cluster: tab.cluster, params: { ...params, mode: "edit" } })}>
              <Code aria-hidden />
              Edit YAML
            </Button>
          </div>
          <span className="text-meta text-fg-muted">
            {kindName(kind)}
            {ns ? ` · ${ns}` : ""} · {tab.cluster}
          </span>
        </div>
        <Tabs defaultValue="yaml" className="flex min-h-0 flex-1 flex-col">
          <TabsList aria-label="Sections" className="mt-1 gap-3 px-4 pt-1.5">
            {secret && <TabsTrigger value="data">Data</TabsTrigger>}
            <TabsTrigger value="yaml">YAML</TabsTrigger>
            <TabsTrigger value="events">Events {events !== null && <TabCount>{events.length}</TabCount>}</TabsTrigger>
          </TabsList>
          {secret && (
            <TabsContent value="data" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <SecretKeys cluster={tab.cluster ?? ""} namespace={ns} name={name} keys={secret.keys} type={secret.type} />
            </TabsContent>
          )}
          <TabsContent value="yaml" className="min-h-0 flex-1 overflow-auto">
            {error ? (
              <EmptyState title="Could not read the object">
                <span className="selectable font-mono">{error}</span>
              </EmptyState>
            ) : yaml === null ? (
              <EmptyState title="Reading…" />
            ) : (
              <pre className="selectable m-0 whitespace-pre px-4 py-3 font-mono text-meta leading-5 text-fg">{yaml}</pre>
            )}
          </TabsContent>
          <TabsContent value="events" className="min-h-0 flex-1 overflow-y-auto">
            {events === null ? <EmptyState title="Reading events…" /> : events.length ? <EventsPanel events={events} /> : <EmptyState title="No recent events" />}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
