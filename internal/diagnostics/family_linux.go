//go:build linux

package diagnostics

import (
	"os"
	"strconv"
	"strings"
)

// clockTicks is USER_HZ, the unit of /proc/<pid>/stat CPU times (100 on Linux).
const clockTicks = 100

// FamilyUsage sums this process and every descendant (WebKitGTK's web and
// network processes are children of the app): cumulative CPU time,
// voluntary context switches (wakeups) and resident memory.
func FamilyUsage() Family {
	self := os.Getpid()
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return Family{}
	}
	parent := map[int]int{}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if f := statFields(pid); len(f) > 1 {
			parent[pid], _ = strconv.Atoi(f[1])
		}
	}
	inFamily := func(pid int) bool {
		for p, hops := pid, 0; p > 1 && hops < 64; p, hops = parent[p], hops+1 {
			if p == self {
				return true
			}
		}
		return false
	}
	fam := Family{Supported: true}
	for pid := range parent {
		if !inFamily(pid) {
			continue
		}
		f := statFields(pid)
		if len(f) < 22 {
			continue
		}
		ut, _ := strconv.ParseFloat(f[11], 64) // utime (field 14)
		st, _ := strconv.ParseFloat(f[12], 64) // stime (field 15)
		fam.Processes++
		fam.CPUTimeMs += (ut + st) * 1000 / clockTicks
		if raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/status"); err == nil {
			for _, line := range strings.Split(string(raw), "\n") {
				k, v, ok := strings.Cut(line, ":")
				if !ok {
					continue
				}
				n, _ := strconv.ParseInt(strings.Fields(v + " 0")[0], 10, 64)
				switch k {
				case "voluntary_ctxt_switches":
					fam.VoluntarySwitches += n
				case "VmRSS":
					fam.RSSMB += float64(n) / 1024
				}
			}
		}
	}
	return fam
}

// statFields returns /proc/<pid>/stat after the command name: [state, ppid, …].
func statFields(pid int) []string {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return nil
	}
	s := string(raw)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return nil
	}
	return strings.Fields(s[i+1:])
}
