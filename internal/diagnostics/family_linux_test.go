//go:build linux

package diagnostics

import (
	"os/exec"
	"testing"
)

func TestFamilyUsageCountsChildren(t *testing.T) {
	cmd := exec.Command("sleep", "5")
	if err := cmd.Start(); err != nil {
		t.Skip(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	f := FamilyUsage()
	if !f.Supported || f.Processes < 2 || f.RSSMB <= 0 || f.CPUTimeMs < 0 {
		t.Fatalf("family = %+v", f)
	}
}
