//go:build !linux && !(darwin && cgo)

package diagnostics

// ResidentMB is not measured on this platform.
func ResidentMB() float64 { return 0 }
