package kube

import (
	"fmt"
	"time"

	"helm.sh/helm/v4/pkg/action"
	helmkube "helm.sh/helm/v4/pkg/kube"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/discovery/cached/memory"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/restmapper"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// restGetter adapts an existing rest.Config to Helm's RESTClientGetter.
type restGetter struct {
	cfg       *rest.Config
	namespace string
}

func (g restGetter) ToRESTConfig() (*rest.Config, error) { return rest.CopyConfig(g.cfg), nil }

func (g restGetter) ToDiscoveryClient() (discovery.CachedDiscoveryInterface, error) {
	dc, err := discovery.NewDiscoveryClientForConfig(g.cfg)
	if err != nil {
		return nil, err
	}
	return memory.NewMemCacheClient(dc), nil
}

func (g restGetter) ToRESTMapper() (meta.RESTMapper, error) {
	dc, err := g.ToDiscoveryClient()
	if err != nil {
		return nil, err
	}
	return restmapper.NewDeferredDiscoveryRESTMapper(dc), nil
}

func (g restGetter) ToRawKubeConfigLoader() clientcmd.ClientConfig {
	cfg := clientcmdapi.NewConfig()
	cfg.Contexts["clustrail"] = &clientcmdapi.Context{Namespace: g.namespace}
	cfg.CurrentContext = "clustrail"
	return clientcmd.NewDefaultClientConfig(*cfg, &clientcmd.ConfigOverrides{})
}

// RollbackRelease runs `helm rollback <name> <revision> --wait --timeout 5m`
// with the bundled Helm SDK. Progress is reported as a Job.
func (m *Manager) RollbackRelease(cluster, ns, name string, revision int) (string, error) {
	c, err := m.writable(cluster)
	if err != nil {
		return "", err
	}
	cfg, err := helmConfig(c, ns)
	if err != nil {
		return "", err
	}
	rb := action.NewRollback(cfg)
	rb.Version = revision
	rb.Timeout = 5 * time.Minute
	rb.WaitStrategy = helmkube.StatusWatcherStrategy
	rb.Description = fmt.Sprintf("Rollback to %d (Clustrail)", revision)

	jobID := fmt.Sprintf("helm-%s-%s-%s-%d", cluster, ns, name, time.Now().UnixMilli())
	report := func(j Job) { j.ID, j.Title = jobID, "Rolling back "+name; m.emit.Emit(EventJob, j) }
	report(Job{Progress: 0.2, Detail: fmt.Sprintf("to revision %d · waiting for resources", revision)})
	safeGo("Helm rollback", func(err error) { report(Job{Done: true, Error: err.Error()}) }, func() {
		if err := rb.Run(name); err != nil {
			report(Job{Done: true, Error: err.Error()})
			return
		}
		report(Job{Done: true, Progress: 1, Detail: fmt.Sprintf("rolled back to revision %d", revision)})
	})
	return jobID, nil
}
