// Package app exposes the kube.Manager to the frontend as a Wails service.
// Every method is callable from TypeScript through the Wails runtime; long
// operations return immediately and report through events.
package app

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/user"
	"path/filepath"
	"strings"

	"github.com/mihnk/clustrail/internal/kube"
	"github.com/mihnk/clustrail/internal/streaming"
	"github.com/wailsapp/wails/v3/pkg/application"
	"sigs.k8s.io/yaml"
)

// Version is set at build time (-ldflags "-X github.com/mihnk/clustrail/internal/app.Version=…").
var Version = "0.9.0-dev"

type Workspace struct {
	m    *kube.Manager
	user string
	pods *streaming.Hub[kube.PodRow]
}

type eventEmitter struct{ app *application.App }

func (e eventEmitter) Emit(name string, data any) { e.app.Event.Emit(name, data) }

func (w *Workspace) ServiceName() string { return "Workspace" }

func (w *Workspace) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	path, err := kube.DefaultStorePath()
	if err != nil {
		return err
	}
	if p := os.Getenv("CLUSTRAIL_CONFIG"); p != "" {
		path = p
	}
	store, err := kube.OpenStore(path)
	if err != nil {
		return err
	}
	w.m = kube.NewManager(ctx, store, eventEmitter{application.Get()})
	w.startPods(ctx)
	if u, err := user.Current(); err == nil {
		w.user = u.Username
	}
	return nil
}

func (w *Workspace) ServiceShutdown() error {
	if w.m != nil {
		w.m.CleanupNodeShells()
		w.m.Shutdown()
	}
	return nil
}

// Info tells the frontend it runs on the real backend.
type Info struct {
	Version string `json:"version"`
	User    string `json:"user"`
}

func (w *Workspace) Hello() Info { return Info{Version: Version, User: w.user} }

// Clusters and connections.

func (w *Workspace) Clusters() kube.ClusterList                  { return w.m.List() }
func (w *Workspace) Snapshot() kube.Snapshot                     { return w.m.Snapshot() }
func (w *Workspace) Connect(id string)                           { w.m.Connect(id) }
func (w *Workspace) Disconnect(id string)                        { w.m.Disconnect(id) }
func (w *Workspace) HideCluster(id string) error                 { return w.m.Hide(id) }
func (w *Workspace) SetSelected(ids []string) error              { return w.m.SetSelected(ids) }
func (w *Workspace) AutoConnect()                                { w.m.AutoConnect() }
func (w *Workspace) Namespaces(cluster string) ([]string, error) { return w.m.ListNamespaces(cluster) }

func (w *Workspace) UpdateCluster(id string, env kube.Environment, protected, readOnly bool) error {
	return w.m.UpdateSettings(id, env, protected, readOnly)
}

func (w *Workspace) AddCluster(id string, env kube.Environment, protected, readOnly bool) error {
	return w.m.Add(id, env, protected, readOnly)
}

// Pods, Deployments, Nodes.

func (w *Workspace) PodDetail(cluster, ns, name string) (kube.PodDetail, error) {
	return w.m.GetPodDetail(cluster, ns, name)
}

func (w *Workspace) Events(cluster, ns, kind, name string) ([]kube.ResourceEvent, error) {
	return w.m.EventsFor(cluster, ns, kind, name)
}

func (w *Workspace) DeletePod(cluster, ns, name string) error {
	return audit("delete pod", cluster, target(ns, name), w.m.DeletePod(cluster, ns, name))
}

func (w *Workspace) RestartDeployment(cluster, ns, name string) error {
	return audit("restart deployment", cluster, target(ns, name), w.m.RestartDeployment(cluster, ns, name))
}

func (w *Workspace) ScaleDeployment(cluster, ns, name string, replicas int32) error {
	return audit(fmt.Sprintf("scale deployment to %d", replicas), cluster, target(ns, name), w.m.ScaleDeployment(cluster, ns, name, replicas))
}

func (w *Workspace) RollbackDeployment(cluster, ns, name string, revision int64) error {
	return audit(fmt.Sprintf("roll back deployment to revision %d", revision), cluster, target(ns, name), w.m.RollbackDeployment(cluster, ns, name, revision))
}

func (w *Workspace) SetDeploymentPaused(cluster, ns, name string, paused bool) error {
	return audit(fmt.Sprintf("set deployment paused=%t", paused), cluster, target(ns, name), w.m.SetDeploymentPaused(cluster, ns, name, paused))
}

func (w *Workspace) DeleteDeployment(cluster, ns, name string) error {
	return audit("delete deployment", cluster, target(ns, name), w.m.DeleteDeployment(cluster, ns, name))
}

func (w *Workspace) SetNodeCordoned(cluster, node string, cordoned bool) error {
	return audit(fmt.Sprintf("set node cordoned=%t", cordoned), cluster, node, w.m.SetNodeCordoned(cluster, node, cordoned, w.user))
}

func (w *Workspace) PreviewDrain(cluster, node string, opts kube.DrainOptions) (kube.DrainPlan, error) {
	return w.m.PreviewDrain(cluster, node, opts)
}

func (w *Workspace) DrainNode(cluster, node string, opts kube.DrainOptions) (string, error) {
	job, err := w.m.DrainNode(cluster, node, opts, w.user)
	return job, audit("drain node", cluster, node, err)
}

// StatefulSets, DaemonSets, Jobs and CronJobs.

func (w *Workspace) RestartWorkload(cluster, kind, ns, name string) error {
	return audit("restart "+strings.ToLower(kindName(kind)), cluster, target(ns, name), w.m.RestartWorkload(cluster, kind, ns, name))
}

func (w *Workspace) ScaleWorkload(cluster, kind, ns, name string, replicas int32) error {
	return audit(fmt.Sprintf("scale %s to %d", strings.ToLower(kindName(kind)), replicas), cluster, target(ns, name), w.m.ScaleWorkload(cluster, kind, ns, name, replicas))
}

func (w *Workspace) WorkloadReplicas(cluster, kind, ns, name string) (int32, error) {
	return w.m.WorkloadReplicas(cluster, kind, ns, name)
}

func (w *Workspace) TriggerCronJob(cluster, ns, name string) (string, error) {
	job, err := w.m.TriggerCronJob(cluster, ns, name)
	return job, audit("run cronjob now", cluster, target(ns, name), err)
}

func (w *Workspace) SetCronJobSuspended(cluster, ns, name string, suspended bool) error {
	return audit(fmt.Sprintf("set cronjob suspend=%t", suspended), cluster, target(ns, name), w.m.SetCronJobSuspended(cluster, ns, name, suspended))
}

func (w *Workspace) JobStatus(cluster, ns, name string) (kube.JobStatus, error) {
	return w.m.JobStatus(cluster, ns, name)
}

// Warnings, access and expiry.

func (w *Workspace) ClusterWarnings(cluster string, sinceSec int) (kube.WarningList, error) {
	return w.m.ClusterWarnings(cluster, sinceSec)
}

func (w *Workspace) AccessMatrix(cluster string, subject kube.AccessSubject, namespace string) (kube.AccessResult, error) {
	return w.m.AccessMatrix(cluster, subject, namespace)
}

func (w *Workspace) WarningCount(cluster string, sinceSec int) (int, error) {
	return w.m.WarningCount(cluster, sinceSec)
}

func (w *Workspace) Expiry(cluster string) (kube.ExpiryReport, error) { return w.m.Expiry(cluster) }

// Debugging.

func (w *Workspace) AddDebugContainer(req kube.DebugRequest) (kube.DebugContainer, error) {
	dc, err := w.m.AddDebugContainer(req)
	_ = audit(fmt.Sprintf("add debug container (image %s, profile %s, target %s)", req.Image, orDash(req.Profile), orDash(req.Target)), req.Cluster, target(req.Namespace, req.Pod), err)
	return dc, err
}

func (w *Workspace) StartNodeShell(req kube.NodeShellRequest) (kube.NodeShell, error) {
	ns, err := w.m.StartNodeShell(req)
	_ = audit(fmt.Sprintf("start node shell (image %s)", req.Image), req.Cluster, req.Node, err)
	return ns, err
}

func (w *Workspace) DeleteNodeShell(cluster, ns, pod string) error {
	return audit("delete node shell", cluster, target(ns, pod), w.m.DeleteNodeShell(cluster, ns, pod))
}

func kindName(kind string) string { return kind[strings.LastIndex(kind, "/")+1:] }

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// YAML.

func (w *Workspace) GetObject(cluster, kind, ns, name string) (kube.LiveObject, error) {
	return w.m.GetObject(cluster, kind, ns, name)
}

// Background and memory (Settings).

func (w *Workspace) PauseWatches() []string { return w.m.PauseWatches() }
func (w *Workspace) ResumeWatches()         { w.m.ResumeWatches() }
func (w *Workspace) SetCacheBudget(mb int)  { kube.SetCacheBudget(mb) }
func (w *Workspace) MemoryStats() kube.MemoryStats {
	return w.m.MemoryStats()
}

// SetUpdateMethod switches between watches and 30 s polling. Generic lists
// follow at once; connected clusters on their next connect.
func (w *Workspace) SetUpdateMethod(method string) {
	kube.SetPollMode(method == "poll")
	slog.Info("update method", "method", method)
}

// RevealSecretKey shows one Secret value. Who revealed which key is logged; the value never is.
func (w *Workspace) RevealSecretKey(cluster, ns, name, key string) (kube.SecretValue, error) {
	v, err := w.m.RevealSecretKey(cluster, ns, name, key)
	if err == nil {
		slog.Info("secret value revealed", "cluster", cluster, "secret", target(ns, name), "key", key, "user", w.user)
	}
	return v, err
}

// Port forwards.

func (w *Workspace) StartPortForward(req kube.PortForwardRequest) (kube.PortForward, error) {
	pf, err := w.m.StartPortForward(req)
	if err != nil {
		slog.Warn("port forward failed", "cluster", req.Cluster, "target", target(req.Namespace, req.Kind, req.Name), "port", req.Port, "error", err)
	} else {
		slog.Info("port forward started", "cluster", req.Cluster, "target", target(req.Namespace, req.Kind, req.Name), "port", req.Port, "local", pf.LocalPort)
	}
	return pf, err
}

func (w *Workspace) StopPortForward(id string) { w.m.StopPortForward(id) }

func (w *Workspace) PortForwards() []kube.PortForward { return w.m.PortForwards() }

func (w *Workspace) ForwardablePorts(cluster, kind, ns, name string) ([]kube.PortOption, error) {
	return w.m.ForwardablePorts(cluster, kind, ns, name)
}

// Generic lists: any kind the cluster serves, with the server's columns.

func (w *Workspace) ResourceKinds(cluster string) ([]kube.KindInfo, error) {
	return w.m.ResourceKinds(cluster)
}

func (w *Workspace) ListResources(cluster, kind, namespace string) (kube.GenericList, error) {
	return w.m.ListResources(cluster, kind, namespace)
}

func (w *Workspace) CreateObjects(cluster, text string, dryRun bool) ([]kube.CreateResult, error) {
	res, err := w.m.CreateObjects(cluster, text, dryRun)
	if !dryRun {
		for _, r := range res {
			if r.Status == "created" || r.Status == "failed" {
				var e error
				if r.Error != "" {
					e = fmt.Errorf("%s", r.Error)
				}
				_ = audit("create "+r.Kind, cluster, target(r.Namespace, r.Name), e)
			}
		}
		if err != nil {
			_ = audit("create from YAML", cluster, "", err)
		}
	}
	return res, err
}

func (w *Workspace) StartListWatch(cluster, kind, namespace string) (string, error) {
	return w.m.StartListWatch(cluster, kind, namespace)
}

func (w *Workspace) StopListWatch(id string) { w.m.StopListWatch(id) }

func (w *Workspace) DeleteResource(cluster, kind, ns, name string) error {
	return audit("delete "+kind, cluster, target(ns, name), w.m.DeleteResource(cluster, kind, ns, name))
}

func (w *Workspace) ApplyYAML(cluster, text, openedVersion string, dryRun, force bool) (kube.ApplyResult, error) {
	res, err := w.m.ApplyYAML(cluster, text, openedVersion, dryRun, force)
	if !dryRun {
		if err == nil && res.Conflict != "" {
			err = fmt.Errorf("conflict: %s", res.Conflict)
		}
		_ = audit(fmt.Sprintf("server-side apply (force=%t)", force), cluster, yamlTarget(text), err)
	}
	return res, err
}

// Helm and GitOps.

func (w *Workspace) RollbackRelease(cluster, ns, name string, revision int) (string, error) {
	job, err := w.m.RollbackRelease(cluster, ns, name, revision)
	return job, audit(fmt.Sprintf("helm rollback to revision %d", revision), cluster, target(ns, name), err)
}

func (w *Workspace) RefreshGitOps(cluster, kind, ns, name string) error {
	return audit("refresh "+kind, cluster, target(ns, name), w.m.RefreshGitOps(cluster, kind, ns, name))
}

func (w *Workspace) SyncGitOps(cluster, kind, ns, name string) error {
	return audit("sync "+kind, cluster, target(ns, name), w.m.SyncGitOps(cluster, kind, ns, name))
}

func (w *Workspace) SetGitOpsSuspended(cluster, kind, ns, name string, suspended bool) error {
	return audit(fmt.Sprintf("set %s suspended=%t", kind, suspended), cluster, target(ns, name), w.m.SetGitOpsSuspended(cluster, kind, ns, name, suspended))
}

// Logs and shells.

func (w *Workspace) StartLogs(req kube.LogsRequest) (string, error) { return w.m.StartLogs(req) }
func (w *Workspace) StopLogs(id string)                             { w.m.StopLogs(id) }
func (w *Workspace) StartExec(req kube.ExecRequest) (string, error) {
	id, err := w.m.StartExec(req)
	// A shell can change the workload; who opened it where is recorded (never what was typed).
	_ = audit("open shell", req.Cluster, target(req.Namespace, req.Pod, req.Container), err)
	return id, err
}
func (w *Workspace) ExecInput(id, data string) error         { return w.m.ExecInput(id, data) }
func (w *Workspace) ExecResize(id string, cols, rows uint16) { w.m.ExecResize(id, cols, rows) }
func (w *Workspace) CloseExec(id string)                     { w.m.CloseExec(id) }

func (w *Workspace) TestConnection(id string) ([]kube.TestStep, error) { return w.m.TestConnection(id) }

// First-run setup.
func (w *Workspace) Setup() kube.SetupInfo                             { return w.m.Setup() }
func (w *Workspace) SetupTest(id string) (kube.SetupTestResult, error) { return w.m.SetupTest(id) }
func (w *Workspace) PasteKubeconfig(text string) (string, error)       { return w.m.PasteKubeconfig(text) }
func (w *Workspace) SkipSetup() error                                  { return w.m.SkipSetup() }
func (w *Workspace) RestartSetup() error                               { return w.m.RestartSetup() }
func (w *Workspace) CompleteSetup(choices []kube.SetupChoice, selected []string) error {
	return w.m.CompleteSetup(choices, selected)
}

// AddKubeconfig asks for a kubeconfig file with the native file dialog and adds it.
// It returns the chosen path, or "" when the dialog was cancelled.
func (w *Workspace) AddKubeconfig() (string, error) {
	home, _ := os.UserHomeDir()
	path, err := application.Get().Dialog.OpenFile().
		SetTitle("Add kubeconfig file").
		SetDirectory(filepath.Join(home, ".kube")).
		ShowHiddenFiles(true).
		CanChooseFiles(true).
		PromptForSingleSelection()
	if err != nil || path == "" {
		return "", err
	}
	return path, w.m.AddKubeconfig(path)
}

func (w *Workspace) HelmRepositories() ([]kube.HelmRepository, error) { return kube.HelmRepositories() }

func (w *Workspace) HelmRevision(cluster, ns, name string, rev int) (kube.HelmRevisionDetail, error) {
	return w.m.GetHelmRevision(cluster, ns, name, rev)
}

func (w *Workspace) DeploymentRelations(cluster, ns, name string) ([]kube.PodRelation, error) {
	return w.m.DeploymentRelations(cluster, ns, name)
}

// yamlTarget names the object of a YAML document for the log, without its content.
func yamlTarget(text string) string {
	var obj struct {
		Kind     string `json:"kind"`
		Metadata struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
		} `json:"metadata"`
	}
	if yaml.Unmarshal([]byte(text), &obj) != nil {
		return ""
	}
	return target(obj.Kind, obj.Metadata.Namespace, obj.Metadata.Name)
}
