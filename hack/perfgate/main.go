// Command perfgate compares two runs of `go test -bench` (the base branch
// and the change, on the same machine) and fails when the change is slower
// or allocates more beyond the threshold (issue A3).
//
//	go run ./hack/perfgate -threshold 10 base.txt head.txt
//
// For each benchmark and metric (ns/op, B/op, allocs/op) it compares the
// medians of the runs. A regression counts when the median got worse by
// more than the threshold and the two samples really differ (Mann-Whitney
// U, p < 0.05), so one noisy run does not fail a change. The table is
// written as Markdown to stdout (and to $GITHUB_STEP_SUMMARY when set).
package main

import (
	"bufio"
	"flag"
	"fmt"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type samples map[string]map[string][]float64 // benchmark → metric → values

var line = regexp.MustCompile(`^(Benchmark\S+?)(?:-\d+)?\s+\d+\s+(.*)$`)

func parse(path string) (samples, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	out := samples{}
	pkg := ""
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		t := sc.Text()
		if p, ok := strings.CutPrefix(t, "pkg: "); ok {
			pkg = p[strings.LastIndex(p, "/")+1:] + "."
			continue
		}
		m := line.FindStringSubmatch(t)
		if m == nil {
			continue
		}
		name := pkg + m[1]
		fields := strings.Fields(m[2])
		for i := 0; i+1 < len(fields); i += 2 {
			v, err := strconv.ParseFloat(fields[i], 64)
			if err != nil {
				continue
			}
			unit := fields[i+1]
			if out[name] == nil {
				out[name] = map[string][]float64{}
			}
			out[name][unit] = append(out[name][unit], v)
		}
	}
	return out, sc.Err()
}

func median(v []float64) float64 {
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	n := len(s)
	if n == 0 {
		return math.NaN()
	}
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

// mannWhitneyP is the two-sided p-value of the Mann-Whitney U test, by the
// normal approximation with a tie correction (enough for 6-20 runs a side).
func mannWhitneyP(a, b []float64) float64 {
	type obs struct {
		v float64
		a bool
	}
	all := make([]obs, 0, len(a)+len(b))
	for _, v := range a {
		all = append(all, obs{v, true})
	}
	for _, v := range b {
		all = append(all, obs{v, false})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].v < all[j].v })
	n := float64(len(all))
	ranks := make([]float64, len(all))
	tie := 0.0
	for i := 0; i < len(all); {
		j := i
		for j < len(all) && all[j].v == all[i].v {
			j++
		}
		r := float64(i+j+1) / 2 // average rank, 1-based
		for k := i; k < j; k++ {
			ranks[k] = r
		}
		t := float64(j - i)
		tie += t*t*t - t
		i = j
	}
	ra := 0.0
	for i, o := range all {
		if o.a {
			ra += ranks[i]
		}
	}
	na, nb := float64(len(a)), float64(len(b))
	u := ra - na*(na+1)/2
	mu := na * nb / 2
	sigma := math.Sqrt(na * nb / 12 * ((n + 1) - tie/(n*(n-1))))
	if sigma == 0 {
		if u == mu {
			return 1
		}
		return 0
	}
	z := max(0, math.Abs(u-mu)-0.5) / sigma
	return min(1, math.Erfc(z/math.Sqrt2))
}

type row struct {
	name, unit       string
	base, head, diff float64
	p                float64
	regressed        bool
}

func compare(base, head samples, threshold float64) []row {
	var rows []row
	for name, metrics := range head {
		for unit, hv := range metrics {
			bv := base[name][unit]
			if len(bv) == 0 {
				continue
			}
			b, h := median(bv), median(hv)
			diff := 0.0
			if b != 0 {
				diff = (h - b) / b * 100
			} else if h != 0 {
				diff = 100
			}
			p := mannWhitneyP(bv, hv)
			// allocs/op is deterministic: any growth past the threshold counts.
			significant := p < 0.05 || (unit == "allocs/op" && b != h)
			worse := diff > threshold
			if strings.HasSuffix(unit, "/s") { // throughput: lower is worse
				worse = diff < -threshold
			}
			rows = append(rows, row{name, unit, b, h, diff, p, worse && significant})
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].name != rows[j].name {
			return rows[i].name < rows[j].name
		}
		return rows[i].unit < rows[j].unit
	})
	return rows
}

func format(v float64) string {
	switch {
	case v >= 1e9:
		return fmt.Sprintf("%.2fG", v/1e9)
	case v >= 1e6:
		return fmt.Sprintf("%.2fM", v/1e6)
	case v >= 1e3:
		return fmt.Sprintf("%.1fk", v/1e3)
	}
	return fmt.Sprintf("%.0f", v)
}

func main() {
	threshold := flag.Float64("threshold", 10, "percent a median may get worse")
	flag.Parse()
	if flag.NArg() != 2 {
		fmt.Fprintln(os.Stderr, "usage: perfgate [-threshold 10] base.txt head.txt")
		os.Exit(2)
	}
	base, err := parse(flag.Arg(0))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	head, err := parse(flag.Arg(1))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	rows := compare(base, head, *threshold)
	var b strings.Builder
	fmt.Fprintf(&b, "### Go benchmarks: change against base (same machine)\n\n| Benchmark | Metric | Base | Change | Δ | p |\n|---|---|---|---|---|---|\n")
	failed := 0
	for _, r := range rows {
		mark := ""
		if r.regressed {
			mark = " ⚠"
			failed++
		}
		fmt.Fprintf(&b, "| %s | %s | %s | %s | %+.1f%%%s | %.3f |\n", r.name, r.unit, format(r.base), format(r.head), r.diff, mark, r.p)
	}
	if failed > 0 {
		fmt.Fprintf(&b, "\n**%d regression(s) over %.0f%% (p < 0.05).** Re-run to rule out a noisy runner; the noise floor is in docs/benchmarks/perf-gate.md.\n", failed, *threshold)
	} else {
		fmt.Fprintf(&b, "\nNo regression over %.0f%%.\n", *threshold)
	}
	fmt.Print(b.String())
	if f := os.Getenv("GITHUB_STEP_SUMMARY"); f != "" {
		if fh, err := os.OpenFile(f, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil { //nolint:gosec // the job summary file GitHub Actions names
			_, _ = fh.WriteString(b.String())
			_ = fh.Close()
		}
	}
	if failed > 0 {
		os.Exit(1)
	}
}
