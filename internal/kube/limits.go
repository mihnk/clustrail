package kube

import "fmt"

// Text that crosses the bridge from the UI is parsed only up to these sizes,
// so a pasted file of the wrong kind (a log, a binary) is refused with a clear
// message instead of being parsed into memory. Kubernetes stores one object in
// at most about 1.5 MiB; the limits leave room for comments and formatting.
const (
	maxObjectBytes     = 3 << 20 // one object to apply, or Helm values
	maxManifestBytes   = 8 << 20 // a manifest of several objects, like kubectl create -f
	maxManifestObjects = 500
	maxKubeconfigBytes = 1 << 20
	maxExecInputBytes  = 1 << 20 // one write to a shell: a keystroke or a paste
)

func checkSize(what string, n, limit int) error {
	if n > limit {
		return fmt.Errorf("%s is %s; the limit is %s", what, byteSize(n), byteSize(limit))
	}
	return nil
}

func byteSize(n int) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MiB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KiB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d bytes", n)
}

// maxReleaseBytes is the most a stored Helm release may hold once
// decompressed (the Secret itself is at most 1 MiB).
const maxReleaseBytes = 64 << 20
