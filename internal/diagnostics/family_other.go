//go:build !linux

package diagnostics

// FamilyUsage is measured from outside on this platform (hack/bench.sh): on
// macOS the WebKit processes are not children of the app.
func FamilyUsage() Family { return Family{} }
