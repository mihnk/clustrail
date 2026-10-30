// Package app exposes the kube.Manager to the frontend as a Wails service.
// Every method is callable from TypeScript through the Wails runtime; long
// operations return immediately and report through events.
package app

import (
	"context"
	"os"
	"os/user"
	"path/filepath"

	"github.com/mihnk/clustrail/internal/kube"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Version is set at build time (-ldflags "-X github.com/mihnk/clustrail/internal/app.Version=…").
var Version = "0.9.0-dev"

type Workspace struct {
	m    *kube.Manager
	user string
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
	if u, err := user.Current(); err == nil {
		w.user = u.Username
	}
	return nil
}

func (w *Workspace) ServiceShutdown() error {
	if w.m != nil {
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
	return w.m.DeletePod(cluster, ns, name)
}

func (w *Workspace) RestartDeployment(cluster, ns, name string) error {
	return w.m.RestartDeployment(cluster, ns, name)
}

func (w *Workspace) ScaleDeployment(cluster, ns, name string, replicas int32) error {
	return w.m.ScaleDeployment(cluster, ns, name, replicas)
}

func (w *Workspace) RollbackDeployment(cluster, ns, name string, revision int64) error {
	return w.m.RollbackDeployment(cluster, ns, name, revision)
}

func (w *Workspace) SetDeploymentPaused(cluster, ns, name string, paused bool) error {
	return w.m.SetDeploymentPaused(cluster, ns, name, paused)
}

func (w *Workspace) DeleteDeployment(cluster, ns, name string) error {
	return w.m.DeleteDeployment(cluster, ns, name)
}

func (w *Workspace) SetNodeCordoned(cluster, node string, cordoned bool) error {
	return w.m.SetNodeCordoned(cluster, node, cordoned, w.user)
}

func (w *Workspace) PreviewDrain(cluster, node string, opts kube.DrainOptions) (kube.DrainPlan, error) {
	return w.m.PreviewDrain(cluster, node, opts)
}

func (w *Workspace) DrainNode(cluster, node string, opts kube.DrainOptions) (string, error) {
	return w.m.DrainNode(cluster, node, opts, w.user)
}

// YAML.

func (w *Workspace) GetObject(cluster, kind, ns, name string) (kube.LiveObject, error) {
	return w.m.GetObject(cluster, kind, ns, name)
}

// Port forwards.

func (w *Workspace) StartPortForward(req kube.PortForwardRequest) (kube.PortForward, error) {
	return w.m.StartPortForward(req)
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
	return w.m.CreateObjects(cluster, text, dryRun)
}

func (w *Workspace) StartListWatch(cluster, kind, namespace string) (string, error) {
	return w.m.StartListWatch(cluster, kind, namespace)
}

func (w *Workspace) StopListWatch(id string) { w.m.StopListWatch(id) }

func (w *Workspace) DeleteResource(cluster, kind, ns, name string) error {
	return w.m.DeleteResource(cluster, kind, ns, name)
}

func (w *Workspace) ApplyYAML(cluster, text, openedVersion string, dryRun, force bool) (kube.ApplyResult, error) {
	return w.m.ApplyYAML(cluster, text, openedVersion, dryRun, force)
}

// Helm and GitOps.

func (w *Workspace) RollbackRelease(cluster, ns, name string, revision int) (string, error) {
	return w.m.RollbackRelease(cluster, ns, name, revision)
}

func (w *Workspace) RefreshGitOps(cluster, kind, ns, name string) error {
	return w.m.RefreshGitOps(cluster, kind, ns, name)
}

func (w *Workspace) SyncGitOps(cluster, kind, ns, name string) error {
	return w.m.SyncGitOps(cluster, kind, ns, name)
}

func (w *Workspace) SetGitOpsSuspended(cluster, kind, ns, name string, suspended bool) error {
	return w.m.SetGitOpsSuspended(cluster, kind, ns, name, suspended)
}

// Logs and shells.

func (w *Workspace) StartLogs(req kube.LogsRequest) (string, error) { return w.m.StartLogs(req) }
func (w *Workspace) StopLogs(id string)                             { w.m.StopLogs(id) }
func (w *Workspace) StartExec(req kube.ExecRequest) (string, error) { return w.m.StartExec(req) }
func (w *Workspace) ExecInput(id, data string) error                { return w.m.ExecInput(id, data) }
func (w *Workspace) ExecResize(id string, cols, rows uint16)        { w.m.ExecResize(id, cols, rows) }
func (w *Workspace) CloseExec(id string)                            { w.m.CloseExec(id) }

func (w *Workspace) TestConnection(id string) ([]kube.TestStep, error) { return w.m.TestConnection(id) }

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
