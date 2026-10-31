package kube

import (
	"encoding/base64"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/yaml"
)

// Fuzz targets for the code that hides Secret values: whatever the input, no
// value may leave masked, and a placeholder may never come back as a value.
// They run briefly as normal tests (the seed corpus); explore with e.g.
//
//	go test -run - -fuzz FuzzMaskSecret -fuzztime 60s ./internal/kube

// secretValue makes a fuzz input usable as a value worth checking: short
// strings ("a") appear everywhere and prove nothing.
func secretValue(s string) (string, bool) {
	s = strings.TrimSpace(s)
	return s, len(s) >= 6 && !strings.ContainsAny(s, "\x00")
}

func FuzzMaskSecret(f *testing.F) {
	f.Add("DB_PASSWORD", "hunter2-hunter2", "s3cr3t-token")
	f.Add("tls.key", "-----BEGIN KEY-----", "with \"quotes\" and \n newline")
	f.Fuzz(func(t *testing.T, key, data, stringData string) {
		d, ok1 := secretValue(data)
		sd, ok2 := secretValue(stringData)
		// A value that is part of a key is visible as the key, rightly.
		if !ok1 || !ok2 || key == "" || strings.ContainsAny(key, "\x00") || strings.Contains(key, d) || strings.Contains(key, sd) {
			t.Skip()
		}
		enc := base64.StdEncoding.EncodeToString([]byte(d))
		obj := &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "v1", "kind": "Secret",
			"metadata":   map[string]any{"name": "s", "namespace": "ns"},
			"data":       map[string]any{key: enc},
			"stringData": map[string]any{key + "-plain": sd},
		}}
		// kubectl's copy of the applied object carries the same values.
		applied, _ := json.Marshal(obj.Object)
		obj.SetAnnotations(map[string]string{lastApplied: string(applied)})
		maskSecret(obj)
		// Values, not keys (keys are shown), of the object and of kubectl's copy.
		var vals []string
		stringLeaves(obj.Object, &vals)
		var copied map[string]any
		_ = json.Unmarshal([]byte(obj.GetAnnotations()[lastApplied]), &copied)
		stringLeaves(copied, &vals)
		for _, have := range vals {
			for _, v := range []string{enc, d, sd} {
				if strings.Contains(have, v) && !strings.Contains(key, v) && have != obj.GetAnnotations()[lastApplied] {
					t.Fatalf("value %q left visible in %q", v, have)
				}
			}
		}
	})
}

func FuzzMaskSecretsInManifest(f *testing.F) {
	f.Add("app-secret", "hunter2-hunter2")
	f.Fuzz(func(t *testing.T, name, value string) {
		v, ok := secretValue(value)
		// A value that is part of the name is visible as the name, rightly.
		if !ok || name == "" || strings.ContainsAny(name, "\x00\n:#'\"{}[]&*!|>%@`") || strings.Contains(name, v) {
			t.Skip()
		}
		enc := base64.StdEncoding.EncodeToString([]byte(v))
		doc, _ := yaml.Marshal(map[string]any{"apiVersion": "v1", "kind": "Secret", "metadata": map[string]any{"name": name}, "data": map[string]any{"k": enc}, "stringData": map[string]any{"p": v}})
		manifest := "---\n# Source: chart/templates/secret.yaml\n" + string(doc) + "---\n# Source: chart/templates/cm.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\ndata:\n  a: b\n"
		out := maskSecretsInManifest(manifest)
		if strings.Contains(out, enc) || strings.Contains(out, v) {
			t.Fatalf("value left visible:\n%s", out)
		}
		if !strings.Contains(out, "kind: ConfigMap") || !strings.Contains(out, "# Source: chart/templates/secret.yaml") {
			t.Fatalf("other documents or the source comment lost:\n%s", out)
		}
	})
}

// Helm values: redacting then restoring an unchanged edit gives the release's
// values back exactly; the placeholder never survives as a value.
func FuzzHelmRedactRoundTrip(f *testing.F) {
	f.Add("hunter2-hunter2", "alice", "bob", true)
	f.Add("x-token-value", "a", "a", false)
	f.Fuzz(func(t *testing.T, secret, user1, user2 string, reorder bool) {
		s, ok := secretValue(secret)
		// Helm stores values as JSON: always valid UTF-8.
		// A secret that is part of a user name is visible as the name, rightly.
		if !ok || strings.Contains(s, redactedValue) || user1 == user2 || !utf8.ValidString(s) || !utf8.ValidString(user1) || !utf8.ValidString(user2) || strings.Contains(user1+"\x00"+user2, s) {
			t.Skip()
		}
		live := map[string]any{
			"db":    map[string]any{"password": s, "host": "pg"},
			"users": []any{map[string]any{"name": user1, "password": s + "-1"}, map[string]any{"name": user2, "password": s + "-2"}},
		}
		// Values as Helm stores them: through JSON.
		raw, _ := json.Marshal(live)
		_ = json.Unmarshal(raw, &live)
		shown := toYAML(redact(live).(map[string]any), "{}")
		var parsed map[string]any
		if err := yaml.Unmarshal([]byte(shown), &parsed); err != nil {
			t.Fatalf("the shown values are not YAML: %v\n%s", err, shown)
		}
		var leaves []string
		stringLeaves(parsed, &leaves)
		for _, l := range leaves {
			if strings.Contains(l, s) && l != user1 && l != user2 {
				t.Fatalf("secret shown in %q:\n%s", l, shown)
			}
		}
		edited := shown
		if reorder {
			var v map[string]any
			if err := yaml.Unmarshal([]byte(shown), &v); err != nil {
				t.Skip()
			}
			u := v["users"].([]any)
			v["users"] = []any{u[1], u[0]}
			edited = toYAML(v, "{}") // as the editor shows it

		}
		vals, err := parseUpgradeValues(edited, live)
		if err != nil {
			return // refusing is allowed; restoring wrongly is not
		}
		if b, _ := json.Marshal(vals); strings.Contains(string(b), redactedValue) {
			t.Fatalf("placeholder sent as a value: %s", b)
		}
		users, ok := vals["users"].([]any)
		if !ok {
			t.Fatalf("users lost: %v", vals)
		}
		byName := map[string]string{}
		for _, it := range users {
			m := it.(map[string]any)
			byName[m["name"].(string)] = m["password"].(string)
		}
		if byName[user1] != s+"-1" || byName[user2] != s+"-2" {
			t.Fatalf("a password moved to another user: %v", byName)
		}
		if !reorder && !reflect.DeepEqual(vals, live) {
			t.Fatalf("unchanged values differ:\n got %v\nwant %v", vals, live)
		}
	})
}

func FuzzLevelOf(f *testing.F) {
	for _, s := range []string{"ERROR boom", `{"level":"warn","msg":"x"}`, "level=info msg=ok", "", "\x00\xff", strings.Repeat("e", 1<<16)} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, msg string) {
		switch l := levelOf(msg); l {
		case "", "ERROR", "WARN", "INFO", "DEBUG", "TRACE":
		default:
			t.Fatalf("levelOf(%q) = %q", msg, l)
		}
	})
}

// A Secret whose YAML cannot be read, or that has a value Kubernetes would
// refuse (an unquoted number, kept by Helm in a failed release), is hidden
// whole instead of being shown as it is.
func TestUnreadableSecretsInManifestsAreHidden(t *testing.T) {
	number := "---\n# Source: c/templates/s.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: pin\nstringData:\n  pin: 918273\n  token: tok-abcdef\n"
	broken := "---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: [unclosed\ndata:\n  key: c2VjcmV0LXZhbHVl\n"
	for name, m := range map[string]string{"unquoted number": number, "invalid YAML": broken} {
		out := maskSecretsInManifest(m)
		for _, v := range []string{"918273", "tok-abcdef", "c2VjcmV0LXZhbHVl"} {
			if strings.Contains(out, v) {
				t.Fatalf("%s: %q visible:\n%s", name, v, out)
			}
		}
	}
	if out := maskSecretsInManifest(number); !strings.Contains(out, "pin: (hidden, 6 bytes)") {
		t.Fatalf("a readable Secret keeps its keys:\n%s", out)
	}
}

// Values YAML cannot carry (a control character) were shown as the error
// text "yaml: control characters are not allowed"; upgrading from the editor
// then replaced every value of the release with {yaml: "control characters…"}.
// They are shown as JSON (valid YAML) and come back unchanged.
func TestHelmValuesWithControlCharactersRoundTrip(t *testing.T) {
	live := map[string]any{"banner": "line\x7fone\x1b[0m", "db": map[string]any{"password": "pa\x01ss-word"}}
	shown := toYAML(live, "{}")
	if strings.Contains(shown, "control characters") || strings.Contains(shown, "pa\x01ss") {
		t.Fatalf("shown:\n%s", shown)
	}
	vals, err := parseUpgradeValues(shown, live)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(vals, live) {
		t.Fatalf("values changed:\n got %#v\nwant %#v", vals, live)
	}
}

// stringLeaves collects every string value (not key) under v.
func stringLeaves(v any, out *[]string) {
	switch t := v.(type) {
	case string:
		*out = append(*out, t)
	case map[string]any:
		for _, x := range t {
			stringLeaves(x, out)
		}
	case []any:
		for _, x := range t {
			stringLeaves(x, out)
		}
	}
}
