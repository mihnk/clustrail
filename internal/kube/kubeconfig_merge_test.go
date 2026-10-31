package kube

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"k8s.io/client-go/tools/clientcmd"
)

// The merged config must equal what kubectl's own loader builds from the
// same files, so Clustrail connects where kubectl would.
func TestKubeconfigMergeMatchesKubectl(t *testing.T) {
	cases := map[string][]string{
		// Context in file 1, its cluster and user only in file 2.
		"split definitions": {`
contexts:
- name: dev
  context: {cluster: c, user: u}
`, `
clusters:
- name: c
  cluster: {server: https://second.example}
users:
- name: u
  user: {token: t2}
`},
		// File 1 defines cluster c and user u without using them; file 2 uses
		// them with its own definitions. kubectl takes file 1's.
		"unused first definition": {`
clusters:
- name: c
  cluster: {server: https://first.example, certificate-authority: certs/ca.pem}
users:
- name: u
  user: {token: t1}
`, `
clusters:
- name: c
  cluster: {server: https://second.example}
users:
- name: u
  user: {token: t2}
contexts:
- name: dev
  context: {cluster: c, user: u}
`},
		// The same context name in both files: the first wins.
		"duplicate context": {`
clusters:
- name: a
  cluster: {server: https://a.example}
users:
- name: u
  user: {token: ta}
contexts:
- name: dev
  context: {cluster: a, user: u, namespace: one}
current-context: dev
`, `
clusters:
- name: b
  cluster: {server: https://b.example}
contexts:
- name: dev
  context: {cluster: b, user: u, namespace: two}
- name: other
  context: {cluster: b, user: u}
current-context: other
`},
		// Relative certificate, key, token file and exec command paths are
		// relative to the file that holds them.
		"relative paths": {`
clusters:
- name: c
  cluster: {server: https://c.example, certificate-authority: ca.pem}
users:
- name: u
  user:
    client-certificate: certs/client.pem
    client-key: certs/client.key
- name: e
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1
      command: ./bin/get-token
      interactiveMode: Never
contexts:
- name: cert
  context: {cluster: c, user: u}
- name: exec
  context: {cluster: c, user: e}
`, `
users:
- name: f
  user: {tokenFile: tokens/dev}
contexts:
- name: tokenfile
  context: {cluster: c, user: f}
`},
	}
	for name, files := range cases {
		t.Run(name, func(t *testing.T) {
			var paths []string
			for i, body := range files {
				dir := filepath.Join(t.TempDir(), "f"+string(rune('1'+i)))
				if err := os.MkdirAll(dir, 0o700); err != nil {
					t.Fatal(err)
				}
				p := filepath.Join(dir, "config")
				if err := os.WriteFile(p, []byte("apiVersion: v1\nkind: Config\n"+strings.TrimPrefix(body, "\n")), 0o600); err != nil {
					t.Fatal(err)
				}
				paths = append(paths, p)
			}
			t.Setenv("KUBECONFIG", strings.Join(paths, string(os.PathListSeparator)))

			want, err := (&clientcmd.ClientConfigLoadingRules{Precedence: paths}).Load()
			if err != nil {
				t.Fatal(err)
			}
			got := LoadKubeconfig(nil)
			for _, src := range got.Sources {
				if src.Error != "" {
					t.Fatalf("source %s: %s", src.Path, src.Error)
				}
			}
			if !reflect.DeepEqual(got.Merged.Clusters, want.Clusters) {
				t.Errorf("clusters differ from kubectl:\n got %+v\nwant %+v", got.Merged.Clusters, want.Clusters)
			}
			if !reflect.DeepEqual(got.Merged.AuthInfos, want.AuthInfos) {
				t.Errorf("users differ from kubectl:\n got %+v\nwant %+v", got.Merged.AuthInfos, want.AuthInfos)
			}
			if !reflect.DeepEqual(got.Merged.Contexts, want.Contexts) {
				t.Errorf("contexts differ from kubectl:\n got %+v\nwant %+v", got.Merged.Contexts, want.Contexts)
			}
			if got.Merged.CurrentContext != want.CurrentContext {
				t.Errorf("current context = %q, kubectl %q", got.Merged.CurrentContext, want.CurrentContext)
			}
			// What the UI shows is what is connected to.
			for _, kctx := range got.Contexts {
				ctx := want.Contexts[kctx.Name]
				server := ""
				if c := want.Clusters[ctx.Cluster]; c != nil {
					server = c.Server
				}
				if kctx.Server != server {
					t.Errorf("context %s shows server %q, kubectl connects to %q", kctx.Name, kctx.Server, server)
				}
			}
		})
	}
}

// The REST config Clustrail builds for the "unused first definition" case
// points at the first file's server, like kubectl.
func TestRestConfigUsesKubectlsServer(t *testing.T) {
	dir := t.TempDir()
	f1, f2 := filepath.Join(dir, "a"), filepath.Join(dir, "b")
	_ = os.WriteFile(f1, []byte("apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {server: https://first.example}\n"), 0o600)
	_ = os.WriteFile(f2, []byte("apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {server: https://second.example}\nusers:\n- name: u\n  user: {token: t}\ncontexts:\n- name: dev\n  context: {cluster: c, user: u}\n"), 0o600)
	t.Setenv("KUBECONFIG", f1+string(os.PathListSeparator)+f2)
	kc := LoadKubeconfig(nil)
	cfg, err := clientcmd.NewNonInteractiveClientConfig(*kc.Merged, "dev", &clientcmd.ConfigOverrides{}, nil).ClientConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "https://first.example" || kc.Contexts[0].Server != "https://first.example" {
		t.Fatalf("host = %s, shown = %s", cfg.Host, kc.Contexts[0].Server)
	}
}
