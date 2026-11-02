package kube

import (
	"encoding/base64"
	"fmt"
	"sort"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
)

// Editing a Secret with decoded values. Only the keys the user changed,
// added or removed travel; the others keep their value without leaving the
// cluster. The save carries the resourceVersion that was opened, so a change
// made meanwhile is refused instead of overwritten.

// SecretEditValue is a new value: text, or base64 when Binary.
type SecretEditValue struct {
	Value  string `json:"value"`
	Binary bool   `json:"binary,omitempty"`
}

type SecretUpdate struct {
	Cluster   string `json:"cluster"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	// ResourceVersion is the version the edit started from.
	ResourceVersion string                     `json:"resourceVersion"`
	Set             map[string]SecretEditValue `json:"set"`
	Remove          []string                   `json:"remove"`
}

// SecretEditInfo is what the editor needs before the first change.
type SecretEditInfo struct {
	ResourceVersion string      `json:"resourceVersion"`
	Type            string      `json:"type"`
	Keys            []SecretKey `json:"keys"`
	// Immutable Secrets cannot be changed (only deleted and created again).
	Immutable bool `json:"immutable,omitempty"`
	// Warning names who else writes this Secret: Helm release storage, a
	// service account token controller, or a GitOps tool that reverts edits.
	Warning string `json:"warning,omitempty"`
}

// SecretForEdit reads a Secret's keys (no values) and what limits an edit.
func (m *Manager) SecretForEdit(cluster, ns, name string) (SecretEditInfo, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return SecretEditInfo{}, err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	s, err := c.client.CoreV1().Secrets(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return SecretEditInfo{}, err
	}
	out := SecretEditInfo{ResourceVersion: s.ResourceVersion, Type: string(s.Type), Keys: []SecretKey{}, Immutable: s.Immutable != nil && *s.Immutable}
	for k, v := range s.Data {
		out.Keys = append(out.Keys, SecretKey{Key: k, Bytes: len(v)})
	}
	sort.Slice(out.Keys, func(i, j int) bool { return out.Keys[i].Key < out.Keys[j].Key })
	switch {
	case s.Type == "helm.sh/release.v1":
		out.Warning = "This Secret is a Helm release record. Editing it can make the release unreadable for Helm."
	case s.Type == "kubernetes.io/service-account-token":
		out.Warning = "The token controller fills this Secret; it may write it again."
	case s.Annotations["argocd.argoproj.io/tracking-id"] != "" || s.Labels["argocd.argoproj.io/instance"] != "":
		out.Warning = "Argo CD manages this Secret; with self-heal on, it reverts the edit."
	case s.Labels["kustomize.toolkit.fluxcd.io/name"] != "" || s.Labels["helm.toolkit.fluxcd.io/name"] != "":
		out.Warning = "Flux manages this Secret; it reverts the edit at the next reconcile."
	}
	return out, nil
}

func (u SecretUpdate) validate() error {
	if u.ResourceVersion == "" {
		return fmt.Errorf("the version the edit started from is missing")
	}
	if len(u.Set) == 0 && len(u.Remove) == 0 {
		return fmt.Errorf("nothing to change")
	}
	total := 0
	for k, v := range u.Set {
		if errs := validation.IsConfigMapKey(k); len(errs) > 0 {
			return fmt.Errorf("key %q: %s", k, strings.Join(errs, "; "))
		}
		total += len(v.Value)
	}
	for _, k := range u.Remove {
		if _, both := u.Set[k]; both {
			return fmt.Errorf("key %q is both set and removed", k)
		}
	}
	return checkSize("the new values", total, maxObjectBytes)
}

// UpdateSecret applies an edit. It is refused on read-only contexts, for
// immutable Secrets, and when the Secret changed since ResourceVersion.
func (m *Manager) UpdateSecret(u SecretUpdate) (string, error) {
	c, err := m.writable(u.Cluster)
	if err != nil {
		return "", err
	}
	if err := u.validate(); err != nil {
		return "", err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	s, err := c.client.CoreV1().Secrets(u.Namespace).Get(ctx, u.Name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	if s.Immutable != nil && *s.Immutable {
		return "", fmt.Errorf("secret %s is immutable: it can only be deleted and created again", u.Name)
	}
	if s.ResourceVersion != u.ResourceVersion {
		return "", fmt.Errorf("secret %s changed since it was opened (version %s, now %s); open it again", u.Name, u.ResourceVersion, s.ResourceVersion)
	}
	if s.Data == nil {
		s.Data = map[string][]byte{}
	}
	for k, v := range u.Set {
		b := []byte(v.Value)
		if v.Binary {
			if b, err = base64.StdEncoding.DecodeString(strings.TrimSpace(v.Value)); err != nil {
				return "", fmt.Errorf("key %q: not valid base64: %w", k, err)
			}
		}
		s.Data[k] = b
	}
	for _, k := range u.Remove {
		if _, ok := s.Data[k]; !ok {
			return "", fmt.Errorf("key %q is not in the Secret", k)
		}
		delete(s.Data, k)
	}
	// Update, not apply: the resourceVersion makes the API server refuse a
	// write that raced with another one.
	out, err := c.client.CoreV1().Secrets(u.Namespace).Update(ctx, s, metav1.UpdateOptions{FieldManager: fieldManager.FieldManager})
	if apierrors.IsConflict(err) {
		return "", fmt.Errorf("secret %s changed while saving; open it again", u.Name)
	}
	if err != nil {
		return "", err
	}
	return out.ResourceVersion, nil
}
