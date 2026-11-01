package main

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, name, body string) string {
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func runs(ns []int, allocs int) string {
	s := "pkg: github.com/mihnk/clustrail/internal/mock\n"
	for _, n := range ns {
		s += "BenchmarkSnapshot10k-4   \t      50\t  " + itoa(n) + " ns/op\t 1000 B/op\t " + itoa(allocs) + " allocs/op\n"
	}
	return s
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for ; n > 0; n /= 10 {
		s = string(rune('0'+n%10)) + s
	}
	return s
}

func TestARealSlowdownFails(t *testing.T) {
	base, _ := parse(write(t, "b", runs([]int{1000, 1010, 990, 1005, 995, 1000, 1002, 998}, 10)))
	head, _ := parse(write(t, "h", runs([]int{1200, 1210, 1190, 1205, 1195, 1200, 1202, 1198}, 10)))
	var bad []row
	for _, r := range compare(base, head, 10) {
		if r.regressed {
			bad = append(bad, r)
		}
	}
	if len(bad) != 1 || bad[0].unit != "ns/op" || bad[0].name != "mock.BenchmarkSnapshot10k" {
		t.Fatalf("regressions = %+v", bad)
	}
}

func TestNoiseWithinTheThresholdPasses(t *testing.T) {
	base, _ := parse(write(t, "b", runs([]int{1000, 1100, 950, 1050, 980, 1020, 1000, 1070}, 10)))
	head, _ := parse(write(t, "h", runs([]int{1040, 990, 1080, 1010, 1060, 970, 1030, 1000}, 10)))
	for _, r := range compare(base, head, 10) {
		if r.regressed {
			t.Fatalf("noise counted as a regression: %+v", r)
		}
	}
}

func TestMoreAllocationsFailEvenWithoutNoise(t *testing.T) {
	base, _ := parse(write(t, "b", runs([]int{1000, 1000, 1000, 1000, 1000, 1000}, 100)))
	head, _ := parse(write(t, "h", runs([]int{1000, 1000, 1000, 1000, 1000, 1000}, 120)))
	found := false
	for _, r := range compare(base, head, 10) {
		if r.unit == "allocs/op" && r.regressed {
			found = true
		}
	}
	if !found {
		t.Fatal("20% more allocations must fail")
	}
}

func TestMannWhitney(t *testing.T) {
	if p := mannWhitneyP([]float64{1, 2, 3, 4, 5, 6}, []float64{7, 8, 9, 10, 11, 12}); p > 0.01 {
		t.Fatalf("disjoint samples: p = %.4f", p)
	}
	if p := mannWhitneyP([]float64{1, 3, 5, 7, 9, 11}, []float64{2, 4, 6, 8, 10, 12}); p < 0.5 {
		t.Fatalf("interleaved samples: p = %.4f", p)
	}
}

func TestLowerThroughputIsARegression(t *testing.T) {
	mk := func(v []int) string {
		s := "pkg: x/kube\n"
		for _, n := range v {
			s += "BenchmarkDecode-4  10  1000 ns/op  " + itoa(n) + " MB/s\n"
		}
		return s
	}
	base, _ := parse(write(t, "b", mk([]int{100, 101, 99, 100, 100, 102, 98, 100})))
	head, _ := parse(write(t, "h", mk([]int{80, 81, 79, 80, 80, 82, 78, 80})))
	found := false
	for _, r := range compare(base, head, 10) {
		if r.unit == "MB/s" && r.regressed {
			found = true
		}
	}
	if !found {
		t.Fatal("20% less throughput must fail")
	}
}
