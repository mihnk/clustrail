package kube

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// Secrets are shown like Lens shows them: keys and sizes, values hidden until
// you reveal one key. The YAML sent to the UI carries a placeholder per value;
// edits that keep the placeholder keep the live value.

// SecretInfo lists a Secret's keys without their values.
type SecretInfo struct {
	Type string      `json:"type"`
	Keys []SecretKey `json:"keys"`
}

type SecretKey struct {
	Key   string `json:"key"`
	Bytes int    `json:"bytes"`
}

// SecretValue is one revealed value.
type SecretValue struct {
	Value string `json:"value"`
	// Binary: not UTF-8 text; Value is base64 then.
	Binary bool `json:"binary"`
}

var hiddenValue = regexp.MustCompile(`^\(hidden, \d+ bytes\)$`)

func hiddenPlaceholder(n int) string { return fmt.Sprintf("(hidden, %d bytes)", n) }

func isSecret(gvr schema.GroupVersionResource) bool {
	return gvr.Group == "" && gvr.Resource == "secrets"
}

// maskSecret replaces every value under data (base64) and stringData with a
// placeholder that states its size, and returns the keys.
func maskSecret(obj *unstructured.Unstructured) *SecretInfo {
	info := &SecretInfo{Keys: []SecretKey{}}
	info.Type, _, _ = unstructured.NestedString(obj.Object, "type")
	if data, ok, _ := unstructured.NestedMap(obj.Object, "data"); ok {
		for k, v := range data {
			s, _ := v.(string)
			n := base64.StdEncoding.DecodedLen(len(s))
			if b, err := base64.StdEncoding.DecodeString(s); err == nil {
				n = len(b)
			}
			data[k] = hiddenPlaceholder(n)
			info.Keys = append(info.Keys, SecretKey{Key: k, Bytes: n})
		}
		_ = unstructured.SetNestedMap(obj.Object, data, "data")
	}
	if data, ok, _ := unstructured.NestedMap(obj.Object, "stringData"); ok {
		for k, v := range data {
			s, _ := v.(string)
			data[k] = hiddenPlaceholder(len(s))
		}
		_ = unstructured.SetNestedMap(obj.Object, data, "stringData")
	}
	maskLastApplied(obj)
	sort.Slice(info.Keys, func(i, j int) bool { return info.Keys[i].Key < info.Keys[j].Key })
	return info
}

// lastApplied is where kubectl apply keeps a full copy of the applied object,
// values included.
const lastApplied = "kubectl.kubernetes.io/last-applied-configuration"

// maskLastApplied hides the values in kubectl's last-applied copy the same way;
// unreadable JSON is replaced entirely, never shown.
func maskLastApplied(obj *unstructured.Unstructured) {
	ann := obj.GetAnnotations()
	raw, ok := ann[lastApplied]
	if !ok {
		return
	}
	var copyObj map[string]any
	if err := json.Unmarshal([]byte(raw), &copyObj); err != nil {
		ann[lastApplied] = "(hidden: kubectl's last-applied copy of this Secret)"
		obj.SetAnnotations(ann)
		return
	}
	inner := &unstructured.Unstructured{Object: copyObj}
	for _, field := range []string{"data", "stringData"} {
		m, ok, _ := unstructured.NestedMap(inner.Object, field)
		if !ok {
			continue
		}
		for k, v := range m {
			s, _ := v.(string)
			n := len(s)
			if field == "data" {
				if b, err := base64.StdEncoding.DecodeString(s); err == nil {
					n = len(b)
				}
			}
			m[k] = hiddenPlaceholder(n)
		}
		_ = unstructured.SetNestedMap(inner.Object, m, field)
	}
	masked, _ := json.Marshal(inner.Object)
	ann[lastApplied] = string(masked)
	obj.SetAnnotations(ann)
}

// unmaskSecret puts the live values back for every key that still holds a
// placeholder, so an edit changes only the keys you actually rewrote. A masked
// last-applied copy is put back as it is live: writing placeholders into it
// would break the next kubectl apply.
func unmaskSecret(c *clusterConn, obj *unstructured.Unstructured) error {
	data, hasData, _ := unstructured.NestedMap(obj.Object, "data")
	var hidden []string
	for k, v := range data {
		if s, _ := v.(string); hiddenValue.MatchString(s) {
			hidden = append(hidden, k)
		}
	}
	ann := obj.GetAnnotations()
	maskedCopy := ann[lastApplied] != "" && strings.Contains(ann[lastApplied], "(hidden")
	if len(hidden) == 0 && !maskedCopy {
		return nil
	}
	ctx, cancel := actionCtx()
	defer cancel()
	live, err := c.client.CoreV1().Secrets(obj.GetNamespace()).Get(ctx, obj.GetName(), metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("reading the live Secret to keep its hidden values: %w", err)
	}
	if maskedCopy {
		if v, ok := live.Annotations[lastApplied]; ok {
			ann[lastApplied] = v
		} else {
			delete(ann, lastApplied)
		}
		obj.SetAnnotations(ann)
	}
	if !hasData || len(hidden) == 0 {
		return nil
	}
	for _, k := range hidden {
		v, ok := live.Data[k]
		if !ok {
			return fmt.Errorf("key %q is hidden but not in the live Secret; give it a value or remove it", k)
		}
		data[k] = base64.StdEncoding.EncodeToString(v)
	}
	return unstructured.SetNestedMap(obj.Object, data, "data")
}

// RevealSecretKey returns one value of a Secret, decoded.
func (m *Manager) RevealSecretKey(cluster, ns, name, key string) (SecretValue, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return SecretValue{}, err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	s, err := c.client.CoreV1().Secrets(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return SecretValue{}, err
	}
	v, ok := s.Data[key]
	if !ok {
		if sv, ok := s.StringData[key]; ok {
			return SecretValue{Value: sv}, nil
		}
		return SecretValue{}, fmt.Errorf("key %q not found", key)
	}
	if !utf8.Valid(v) {
		return SecretValue{Value: base64.StdEncoding.EncodeToString(v), Binary: true}, nil
	}
	return SecretValue{Value: string(v)}, nil
}
