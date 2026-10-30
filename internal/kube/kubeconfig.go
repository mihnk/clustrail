package kube

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// KubeContext is one context from the kubeconfig files, with where it came from.
type KubeContext struct {
	Name        string
	DisplayName string
	Server      string
	Auth        string
	AuthPlugin  string
	Namespace   string
	// File the context is defined in, with $HOME shortened to ~.
	Source string
}

// KubeconfigSource describes one file in the loading chain.
type KubeconfigSource struct {
	Path     string `json:"path"`
	Resolved string `json:"resolved,omitempty"`
	Contexts int    `json:"contexts"`
	Watched  bool   `json:"watched"`
	Changed  string `json:"changed,omitempty"`
	Error    string `json:"error,omitempty"`
}

// Kubeconfig is the merged view of every kubeconfig file, kubectl semantics:
// KUBECONFIG (or ~/.kube/config), then files added in Clustrail; the first
// file that defines a context wins.
type Kubeconfig struct {
	Merged   *clientcmdapi.Config
	Contexts []KubeContext
	Sources  []KubeconfigSource
	// Modification times, to detect changes by polling.
	mtimes map[string]time.Time
}

func homeShort(p string) string {
	if home, err := os.UserHomeDir(); err == nil && strings.HasPrefix(p, home+string(filepath.Separator)) {
		return "~" + p[len(home):]
	}
	return p
}

// KubeconfigPaths returns the files in loading order and how each was found.
func KubeconfigPaths(extra []string) (paths []string, labels []string) {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	env := os.Getenv(clientcmd.RecommendedConfigPathEnvVar)
	for _, p := range rules.GetLoadingPrecedence() {
		paths = append(paths, p)
		if env != "" {
			labels = append(labels, "$KUBECONFIG")
		} else {
			labels = append(labels, homeShort(p))
		}
	}
	for _, p := range extra {
		paths = append(paths, p)
		labels = append(labels, homeShort(p))
	}
	return paths, labels
}

// LoadKubeconfig reads every file. Missing files are skipped; unreadable or
// invalid files are reported on their source instead of failing the load.
func LoadKubeconfig(extra []string) *Kubeconfig {
	paths, labels := KubeconfigPaths(extra)
	kc := &Kubeconfig{Merged: clientcmdapi.NewConfig(), mtimes: map[string]time.Time{}}
	seen := map[string]bool{}
	for i, p := range paths {
		src := KubeconfigSource{Path: labels[i], Watched: true}
		if labels[i] != homeShort(p) {
			src.Resolved = homeShort(p)
		}
		st, err := os.Stat(p)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			src.Error = err.Error()
			kc.Sources = append(kc.Sources, src)
			continue
		}
		kc.mtimes[p] = st.ModTime()
		src.Changed = ago(time.Since(st.ModTime()))
		cfg, err := clientcmd.LoadFromFile(p)
		if err != nil {
			src.Error = err.Error()
			kc.Sources = append(kc.Sources, src)
			continue
		}
		for name, ctx := range cfg.Contexts {
			src.Contexts++
			if seen[name] {
				continue
			}
			seen[name] = true
			kc.Merged.Contexts[name] = ctx
			if c, ok := cfg.Clusters[ctx.Cluster]; ok {
				if _, dup := kc.Merged.Clusters[ctx.Cluster]; !dup {
					kc.Merged.Clusters[ctx.Cluster] = resolvePaths(c, p)
				}
			}
			if a, ok := cfg.AuthInfos[ctx.AuthInfo]; ok {
				if _, dup := kc.Merged.AuthInfos[ctx.AuthInfo]; !dup {
					kc.Merged.AuthInfos[ctx.AuthInfo] = resolveAuthPaths(a, p)
				}
			}
			kc.Contexts = append(kc.Contexts, describeContext(name, ctx, cfg, labels[i], p))
		}
		if kc.Merged.CurrentContext == "" {
			kc.Merged.CurrentContext = cfg.CurrentContext
		}
		kc.Sources = append(kc.Sources, src)
	}
	return kc
}

// Changed reports whether any kubeconfig file was modified, added or removed.
func (kc *Kubeconfig) Changed(extra []string) bool {
	paths, _ := KubeconfigPaths(extra)
	n := 0
	for _, p := range paths {
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		n++
		if t, ok := kc.mtimes[p]; !ok || !t.Equal(st.ModTime()) {
			return true
		}
	}
	return n != len(kc.mtimes)
}

// Relative certificate and exec paths in a kubeconfig are relative to the file.
func resolvePaths(c *clientcmdapi.Cluster, file string) *clientcmdapi.Cluster {
	c = c.DeepCopy()
	if c.CertificateAuthority != "" && !filepath.IsAbs(c.CertificateAuthority) {
		c.CertificateAuthority = filepath.Join(filepath.Dir(file), c.CertificateAuthority)
	}
	return c
}

func resolveAuthPaths(a *clientcmdapi.AuthInfo, file string) *clientcmdapi.AuthInfo {
	a = a.DeepCopy()
	dir := filepath.Dir(file)
	for _, f := range []*string{&a.ClientCertificate, &a.ClientKey, &a.TokenFile} {
		if *f != "" && !filepath.IsAbs(*f) {
			*f = filepath.Join(dir, *f)
		}
	}
	return a
}

var (
	eksARN = regexp.MustCompile(`^arn:aws[a-z-]*:eks:[a-z0-9-]+:\d+:cluster/(.+)$`)
	gkeCtx = regexp.MustCompile(`^gke_[^_]+_[^_]+_(.+)$`)
	aksCtx = regexp.MustCompile(`^(.+)-admin$`)
)

// DisplayName shortens provider-generated context names: the EKS ARN and the
// gke_<project>_<zone>_ prefix carry no information the UI shows elsewhere.
func DisplayName(context string) string {
	if m := eksARN.FindStringSubmatch(context); m != nil {
		return m[1]
	}
	if m := gkeCtx.FindStringSubmatch(context); m != nil {
		return m[1]
	}
	if m := aksCtx.FindStringSubmatch(context); m != nil && !strings.Contains(m[1], "/") {
		return context
	}
	return context
}

func describeContext(name string, ctx *clientcmdapi.Context, cfg *clientcmdapi.Config, label, file string) KubeContext {
	kc := KubeContext{Name: name, DisplayName: DisplayName(name), Namespace: ctx.Namespace, Source: label}
	if label == "$KUBECONFIG" {
		kc.Source = homeShort(file)
	}
	if c, ok := cfg.Clusters[ctx.Cluster]; ok {
		kc.Server = c.Server
	}
	if a, ok := cfg.AuthInfos[ctx.AuthInfo]; ok {
		kc.Auth, kc.AuthPlugin = describeAuth(a)
	}
	return kc
}

func describeAuth(a *clientcmdapi.AuthInfo) (label, plugin string) {
	switch {
	case a.Exec != nil:
		cmd := filepath.Base(a.Exec.Command)
		switch {
		case cmd == "aws" || cmd == "aws-iam-authenticator":
			return "exec · aws eks", cmd
		case cmd == "gke-gcloud-auth-plugin" || cmd == "gcloud":
			return "exec · gcloud", cmd
		case cmd == "kubelogin":
			return "exec · kubelogin", cmd
		default:
			return "exec · " + cmd, cmd
		}
	case a.AuthProvider != nil:
		return "auth-provider · " + a.AuthProvider.Name, a.AuthProvider.Name
	case a.ClientCertificate != "" || len(a.ClientCertificateData) > 0:
		return "client cert", ""
	case a.Token != "" || a.TokenFile != "":
		return "token", ""
	case a.Username != "":
		return "basic auth", ""
	default:
		return "none", ""
	}
}

// ReauthCommand is what the user runs in their own terminal when an exec
// plugin's credentials expired. Clustrail never prompts for passwords.
func ReauthCommand(plugin string, a *clientcmdapi.AuthInfo) string {
	switch plugin {
	case "gke-gcloud-auth-plugin", "gcloud":
		return "gcloud auth login"
	case "aws", "aws-iam-authenticator":
		if a != nil && a.Exec != nil {
			for _, e := range a.Exec.Env {
				if e.Name == "AWS_PROFILE" {
					return "aws sso login --profile " + e.Value
				}
			}
			for i, arg := range a.Exec.Args {
				if arg == "--profile" && i+1 < len(a.Exec.Args) {
					return "aws sso login --profile " + a.Exec.Args[i+1]
				}
			}
		}
		return "aws sso login"
	case "kubelogin":
		return "az login"
	case "":
		return ""
	default:
		return fmt.Sprintf("%s (sign in again)", plugin)
	}
}

// GuessEnv suggests a group for a context that has none stored yet.
func GuessEnv(s string) Environment {
	s = strings.ToLower(s)
	switch {
	case strings.Contains(s, "prod") || strings.Contains(s, "prd") || strings.Contains(s, "live"):
		return EnvProd
	case strings.Contains(s, "stag") || strings.Contains(s, "stg") || strings.Contains(s, "preprod") || strings.Contains(s, "uat"):
		return EnvStg
	default:
		return EnvDev
	}
}

// ago formats a duration the way the UI does: 38s, 12m, 3h, 2d, 1y.
func ago(d time.Duration) string {
	s := int64(d.Seconds())
	switch {
	case s < 60:
		return fmt.Sprintf("%ds", max(s, 0))
	case s < 3600:
		return fmt.Sprintf("%dm", s/60)
	case s < 86400:
		return fmt.Sprintf("%dh", s/3600)
	case s < 365*86400:
		return fmt.Sprintf("%dd", s/86400)
	default:
		return fmt.Sprintf("%dy", s/(365*86400))
	}
}
