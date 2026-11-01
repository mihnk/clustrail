package app

import "os/exec"

func startDetached(name string, args ...string) error {
	cmd := exec.Command(name, args...) //nolint:gosec // callers pass fixed programs (open, xdg-open, the terminal); args are paths and URLs, not shell text
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
