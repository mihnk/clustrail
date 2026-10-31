package kube

import (
	"os"
	"path/filepath"
	"sync"
)

// fileLocks serializes writers of the same file in this process (two
// connections of the same cluster saving samples during a reconnect).
var fileLocks sync.Map // path → *sync.Mutex

// writeFileAtomic replaces path with data: a new temporary file in the same
// directory, synced to disk, then renamed over the old one. A crash or a
// full disk leaves either the old file or the new one, never half of one.
func writeFileAtomic(path string, data []byte) error {
	l, _ := fileLocks.LoadOrStore(path, &sync.Mutex{})
	mu := l.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(tmp)
		}
	}()
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	ok = true
	if d, err := os.Open(dir); err == nil { // the rename itself reaches the disk
		_ = d.Sync()
		d.Close()
	}
	return nil
}
