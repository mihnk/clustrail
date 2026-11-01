package kube

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/mihnk/clustrail/internal/streaming"
)

var _ streaming.Patchable[PodRow] = PodRow{}

func samplePodRow() PodRow {
	cpu, mem := 100, 256
	return PodRow{ID: "c/ns/p", UID: "u", Name: "p", Namespace: "ns", Cluster: "c", Env: EnvProd, Node: "n", Health: Healthy, Status: "Running",
		ReadyContainers: 1, TotalContainers: 1, CPUMilli: &cpu, MemoryMiB: &mem, AgeSeconds: 60, Owner: &OwnerRef{Kind: "ReplicaSet", Name: "rs"}, Labels: map[string]string{"app": "a"}}
}

// Every JSON field of PodRow is compared and patched: changing any one is
// reported as exactly that field, and applying the patch to the old row's
// JSON gives the new row's JSON.
func TestPodRowPatchCoversEveryField(t *testing.T) {
	typ := reflect.TypeOf(PodRow{})
	for i := range typ.NumField() {
		f := typ.Field(i)
		name := strings.Split(f.Tag.Get("json"), ",")[0]
		if name == "id" {
			continue
		}
		old := samplePodRow()
		changed := samplePodRow()
		v := reflect.ValueOf(&changed).Elem().Field(i)
		switch v.Kind() {
		case reflect.String:
			v.SetString(v.String() + "-x")
		case reflect.Int, reflect.Int64:
			v.SetInt(v.Int() + 7)
		case reflect.Pointer:
			if v.IsNil() {
				v.Set(reflect.New(f.Type.Elem()))
			} else {
				v.Set(reflect.Zero(f.Type))
			}
		case reflect.Map:
			v.Set(reflect.ValueOf(map[string]string{"app": "b"}))
		default:
			t.Fatalf("field %s: kind %s not covered by this test", f.Name, v.Kind())
		}
		got := changed.ChangedFields(old)
		if len(got) != 1 || got[0] != name {
			t.Fatalf("changing %s reported %v", f.Name, got)
		}
		// old JSON + patch == new JSON
		var merged map[string]any
		raw, _ := json.Marshal(old)
		_ = json.Unmarshal(raw, &merged)
		praw, _ := json.Marshal(changed.Patch(got))
		var patch map[string]any
		_ = json.Unmarshal(praw, &patch)
		for k, val := range patch {
			merged[k] = val
		}
		var want map[string]any
		nraw, _ := json.Marshal(changed)
		_ = json.Unmarshal(nraw, &want)
		if name == "staleSeconds" && changed.StaleSeconds == nil {
			delete(merged, "staleSeconds") // omitempty on the row: nil and absent mean the same to the client
		}
		if !reflect.DeepEqual(merged, want) {
			t.Fatalf("patching %s:\nmerged %v\nwant   %v", f.Name, merged, want)
		}
	}
	if got := samplePodRow().ChangedFields(samplePodRow()); len(got) != 0 {
		t.Fatalf("no change reported %v", got)
	}
}

// One delta of 1,000 pod updates (CPU and memory moved), as whole rows and as
// patches: bytes per change and encode time (issue C6).
func BenchmarkPodDelta(b *testing.B) {
	rows := make([]PodRow, 1000)
	patches := make([]map[string]any, 1000)
	for i := range rows {
		p := samplePodRow()
		p.ID, p.Name, p.Node = "prod-eu-west-1/team-1/app-"+itoa(i), "app-"+itoa(i), "ip-10-42-1-17.eu-west-1.compute.internal"
		p.Labels = map[string]string{"app": "app", "pod-template-hash": "7d9f8b6c4"}
		old := p
		cpu, mem := 200+i, 300
		p.CPUMilli, p.MemoryMiB = &cpu, &mem
		rows[i] = p
		patches[i] = p.Patch(p.ChangedFields(old))
	}
	for _, c := range []struct {
		name string
		v    any
	}{{"whole rows", streaming.Frame[PodRow]{T: "delta", Upserts: rows}}, {"patches", streaming.Frame[PodRow]{T: "delta", Patches: patches}}} {
		b.Run(c.name, func(b *testing.B) {
			var n int
			for b.Loop() {
				raw, _ := json.Marshal(c.v)
				n = len(raw)
			}
			b.ReportMetric(float64(n)/1000, "bytes/change")
		})
	}
}
