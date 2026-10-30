package kube

import (
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
)

// templateUses lists ConfigMaps, Secrets and PVCs a pod spec references by
// name. Secret values are never read.
func templateUses(spec corev1.PodSpec) []RelationObject {
	var uses []RelationObject
	seen := map[string]bool{}
	use := func(kind, n string) {
		if n != "" && !seen[kind+"/"+n] {
			seen[kind+"/"+n] = true
			uses = append(uses, RelationObject{Kind: kind, Name: n})
		}
	}
	for _, v := range spec.Volumes {
		if v.ConfigMap != nil {
			use("cm", v.ConfigMap.Name)
		}
		if v.Secret != nil {
			use("secret", v.Secret.SecretName)
		}
		if v.PersistentVolumeClaim != nil {
			use("pvc", v.PersistentVolumeClaim.ClaimName)
		}
		if v.Projected != nil {
			for _, src := range v.Projected.Sources {
				if src.ConfigMap != nil {
					use("cm", src.ConfigMap.Name)
				}
				if src.Secret != nil {
					use("secret", src.Secret.Name)
				}
			}
		}
	}
	for _, ct := range append(append([]corev1.Container{}, spec.InitContainers...), spec.Containers...) {
		for _, ef := range ct.EnvFrom {
			if ef.ConfigMapRef != nil {
				use("cm", ef.ConfigMapRef.Name)
			}
			if ef.SecretRef != nil {
				use("secret", ef.SecretRef.Name)
			}
		}
		for _, e := range ct.Env {
			if e.ValueFrom != nil && e.ValueFrom.ConfigMapKeyRef != nil {
				use("cm", e.ValueFrom.ConfigMapKeyRef.Name)
			}
			if e.ValueFrom != nil && e.ValueFrom.SecretKeyRef != nil {
				use("secret", e.ValueFrom.SecretKeyRef.Name)
			}
		}
	}
	return uses
}

// managedBy names the tool that owns an object, from its labels and annotations.
func managedBy(meta metav1.ObjectMeta) *PodRelation {
	ann, lbl := meta.Annotations, meta.Labels
	switch {
	case ann["argocd.argoproj.io/tracking-id"] != "":
		app := strings.SplitN(ann["argocd.argoproj.io/tracking-id"], ":", 2)[0]
		return &PodRelation{Label: "Managed by", Objects: []RelationObject{{Kind: "argocd", Name: app}}, Via: "Argo CD tracking annotation"}
	case lbl["argocd.argoproj.io/instance"] != "":
		return &PodRelation{Label: "Managed by", Objects: []RelationObject{{Kind: "argocd", Name: lbl["argocd.argoproj.io/instance"]}}, Via: "label argocd.argoproj.io/instance"}
	case lbl["kustomize.toolkit.fluxcd.io/name"] != "":
		return &PodRelation{Label: "Managed by", Objects: []RelationObject{{Kind: "flux", Name: lbl["kustomize.toolkit.fluxcd.io/name"]}}, Via: "Flux Kustomization labels"}
	case lbl["helm.toolkit.fluxcd.io/name"] != "":
		return &PodRelation{Label: "Managed by", Objects: []RelationObject{{Kind: "flux", Name: lbl["helm.toolkit.fluxcd.io/name"]}}, Via: "Flux HelmRelease labels"}
	case ann["meta.helm.sh/release-name"] != "":
		return &PodRelation{Label: "Managed by", Objects: []RelationObject{{Kind: "helm", Name: ann["meta.helm.sh/release-name"]}}, Via: "annotation meta.helm.sh/release-name"}
	}
	return nil
}

// DeploymentRelations finds what selects, scales, protects and configures a Deployment.
func (m *Manager) DeploymentRelations(cluster, ns, name string) ([]PodRelation, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return nil, err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	d, err := c.client.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	tmplLabels := labels.Set(d.Spec.Template.Labels)
	out := []PodRelation{}

	if svcs, err := c.client.CoreV1().Services(ns).List(ctx, metav1.ListOptions{}); err == nil {
		rel := PodRelation{Label: "Selected by", Objects: []RelationObject{}}
		for _, s := range svcs.Items {
			if len(s.Spec.Selector) > 0 && labels.SelectorFromSet(s.Spec.Selector).Matches(tmplLabels) {
				rel.Objects = append(rel.Objects, RelationObject{Kind: "svc", Name: s.Name})
				rel.Via = "Service selector " + labels.SelectorFromSet(s.Spec.Selector).String()
			}
		}
		if len(rel.Objects) > 0 {
			if d.Status.ReadyReplicas < d.Status.Replicas {
				rel.Pill = &Pill{Text: fmt.Sprintf("%d/%d endpoints ready", d.Status.ReadyReplicas, d.Status.Replicas), Tone: "warning"}
			}
			out = append(out, rel)
		}
	}
	if hpas, err := c.client.AutoscalingV2().HorizontalPodAutoscalers(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for _, h := range hpas.Items {
			if h.Spec.ScaleTargetRef.Kind == "Deployment" && h.Spec.ScaleTargetRef.Name == name {
				min := int32(1)
				if h.Spec.MinReplicas != nil {
					min = *h.Spec.MinReplicas
				}
				out = append(out, PodRelation{Label: "Scaled by", Objects: []RelationObject{{Kind: "hpa", Name: h.Name}},
					Pill: &Pill{Text: fmt.Sprintf("%d–%d replicas", min, h.Spec.MaxReplicas), Tone: "info"}, Via: "scaleTargetRef"})
			}
		}
	}
	if pdbs, err := c.client.PolicyV1().PodDisruptionBudgets(ns).List(ctx, metav1.ListOptions{}); err == nil {
		probe := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Labels: d.Spec.Template.Labels}}
		for i := range pdbs.Items {
			pdb := &pdbs.Items[i]
			if pdbMatches(pdb, probe) {
				rel := PodRelation{Label: "Disruption", Objects: []RelationObject{{Kind: "pdb", Name: pdb.Name}}, Via: "PDB selector",
					Pill: &Pill{Text: fmt.Sprintf("%d allowed", pdb.Status.DisruptionsAllowed), Tone: "info"}}
				if pdb.Status.DisruptionsAllowed == 0 {
					rel.Pill.Tone = "warning"
				}
				out = append(out, rel)
			}
		}
	}
	if uses := templateUses(d.Spec.Template.Spec); len(uses) > 0 {
		out = append(out, PodRelation{Label: "Uses", Objects: uses, Via: "pod template volumes and env references"})
	}
	if mb := managedBy(d.ObjectMeta); mb != nil {
		out = append(out, *mb)
	}
	return out, nil
}
