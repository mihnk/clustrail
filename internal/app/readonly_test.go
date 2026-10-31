package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"github.com/mihnk/clustrail/internal/kube"
)

// Methods that change a cluster: each must refuse a read-only context.
var changesCluster = []string{
	"DeletePod", "RestartDeployment", "ScaleDeployment", "RollbackDeployment", "SetDeploymentPaused", "DeleteDeployment",
	"SetNodeCordoned", "DrainNode",
	"RestartWorkload", "ScaleWorkload", "TriggerCronJob", "SetCronJobSuspended",
	"UpgradeRelease", "RollbackRelease",
	"AddDebugContainer", "StartNodeShell", "StartPortForward", "StartExec",
	"CreateObjects", "ApplyYAML", "DeleteResource",
	"RefreshGitOps", "SyncGitOps", "SetGitOpsSuspended",
}

// Methods allowed on a read-only context: they read, plan without changing
// anything, change only Clustrail's own settings, or clean up what Clustrail
// started (a node shell started before the context became read-only).
var allowedReadOnly = []string{
	// Wails service plumbing, diagnostics, benchmarks, updates
	"ServiceName", "ServiceStartup", "ServiceShutdown", "Hello", "ServePods", "LogFile", "RevealLog", "Diagnostics",
	"ResetDiagnostics", "LogClientError", "BenchConfig", "ReportBench", "SetSyntheticPaused", "PodChecksum", "CheckForUpdates",
	"SetMetricsInterval", "SetCacheBudget", "SetUpdateMethod", "MemoryStats", "PauseWatches", "ResumeWatches",
	// Clustrail's own settings and connections
	"Clusters", "Snapshot", "Connect", "Disconnect", "HideCluster", "SetSelected", "AutoConnect", "ConfirmTarget",
	"UpdateCluster", "AddCluster", "TestConnection", "Setup", "SetupTest", "PasteKubeconfig", "SkipSetup",
	"RestartSetup", "CompleteSetup", "AddKubeconfig", "HelmRepositories",
	// Reading
	"Namespaces", "PodDetail", "Events", "WorkloadReplicas", "JobStatus", "ClusterWarnings", "AccessMatrix",
	"WarningCount", "Expiry", "HelmUpgradeSource", "ServiceChain", "Storage", "PodNetworkPolicies",
	"CheckConnection", "GetObject", "RevealSecretKey", "PortForwards", "ForwardablePorts", "ResourceKinds",
	"ListResources", "StartListWatch", "StopListWatch", "StartLogs", "StopLogs", "HelmRevision",
	"DeploymentRelations",
	// Planning: nothing is changed
	"PreviewDrain", "PlanHelmUpgrade",
	// Sessions that only exist because a change was allowed, and cleanup
	"StopPortForward", "ExecInput", "ExecResize", "CloseExec", "DeleteNodeShell",
}

func readOnlyWorkspace(t *testing.T) *Workspace {
	t.Helper()
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config")
	raw := "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {server: 'https://127.0.0.1:1'}\nusers:\n- name: u\n  user: {token: t}\ncontexts:\n- name: dev\n  context: {cluster: c, user: u}\n"
	if err := os.WriteFile(cfg, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KUBECONFIG", cfg)
	store, err := kube.OpenStore(filepath.Join(dir, "contexts.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetSettings("dev", kube.ContextSettings{Env: kube.EnvDev, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m := kube.NewManager(ctx, store, nopEmitter{})
	t.Cleanup(m.Shutdown)
	return &Workspace{m: m}
}

type nopEmitter struct{}

func (nopEmitter) Emit(string, any) {}

// argsFor builds arguments that name the read-only cluster: the first string
// is the cluster id, a request struct gets it in its Cluster field.
func argsFor(mt reflect.Method) []reflect.Value {
	var args []reflect.Value
	clusterSet := false
	for i := 1; i < mt.Type.NumIn(); i++ { // 0 is the receiver
		in := mt.Type.In(i)
		v := reflect.New(in).Elem()
		switch in.Kind() {
		case reflect.String:
			if !clusterSet {
				v.SetString("dev")
				clusterSet = true
			} else {
				v.SetString("x")
			}
		case reflect.Struct:
			if f := v.FieldByName("Cluster"); f.IsValid() && f.Kind() == reflect.String {
				f.SetString("dev")
				clusterSet = true
			}
		case reflect.Int, reflect.Int32, reflect.Int64:
			v.SetInt(1)
		}
		args = append(args, v)
	}
	return args
}

func TestEveryClusterChangeRefusesReadOnly(t *testing.T) {
	w := readOnlyWorkspace(t)
	typ := reflect.TypeOf(w)
	for i := range typ.NumMethod() {
		mt := typ.Method(i)
		inChanges, allowed := slices.Contains(changesCluster, mt.Name), slices.Contains(allowedReadOnly, mt.Name)
		switch {
		case inChanges && allowed:
			t.Errorf("%s is in both lists", mt.Name)
			continue
		case !inChanges && !allowed:
			t.Errorf("%s is not classified: add it to changesCluster (and call writable first) or to allowedReadOnly", mt.Name)
			continue
		case allowed:
			continue
		}
		out := reflect.ValueOf(w).Method(i).Call(argsFor(mt))
		err, _ := out[len(out)-1].Interface().(error)
		if !errors.Is(err, kube.ErrReadOnly) {
			t.Errorf("%s on a read-only context: err = %v, want the read-only error", mt.Name, err)
		}
	}
	for _, name := range append(slices.Clone(changesCluster), allowedReadOnly...) {
		if _, ok := typ.MethodByName(name); !ok {
			t.Errorf("%s is listed but no longer exists", name)
		}
	}
}
