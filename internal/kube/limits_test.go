package kube

import (
	"strings"
	"testing"
)

// Oversized text from the UI is refused before it is parsed, with its size
// and the limit in the message.
func TestOversizedInputIsRefused(t *testing.T) {
	c, _, _ := newFakeConn(t)
	m := managerWith(c, false)
	big := strings.Repeat("a", maxManifestBytes+1)
	for name, call := range map[string]func() error{
		"apply":      func() error { _, err := m.ApplyYAML("test", big, "", true, false); return err },
		"create":     func() error { _, err := m.CreateObjects("test", big, true); return err },
		"kubeconfig": func() error { _, err := m.PasteKubeconfig(big); return err },
		"values":     func() error { _, err := parseUpgradeValues(big, nil); return err },
	} {
		err := call()
		if err == nil || !strings.Contains(err.Error(), "the limit is") {
			t.Fatalf("%s: err = %v", name, err)
		}
	}
	many := strings.Repeat("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n---\n", maxManifestObjects+1)
	if _, err := m.CreateObjects("test", many, true); err == nil || !strings.Contains(err.Error(), "create them in parts") {
		t.Fatalf("many objects: err = %v", err)
	}
}
