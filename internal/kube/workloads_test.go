package kube

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	authnv1 "k8s.io/api/authentication/v1"
	authzv1 "k8s.io/api/authorization/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/rest"
	k8stesting "k8s.io/client-go/testing"
)

func TestWorkloadRestartAndCronJobActions(t *testing.T) {
	ctx := context.Background()
	sts := &appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "payments"}}
	ds := &appsv1.DaemonSet{ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "kube-system"}}
	cj := &batchv1.CronJob{
		ObjectMeta: metav1.ObjectMeta{Name: "nightly-report", Namespace: "payments", UID: "cj-uid"},
		Spec: batchv1.CronJobSpec{Schedule: "0 2 * * *", JobTemplate: batchv1.JobTemplateSpec{
			ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"team": "billing"}},
			Spec:       batchv1.JobSpec{Template: corev1.PodTemplateSpec{Spec: corev1.PodSpec{RestartPolicy: corev1.RestartPolicyNever, Containers: []corev1.Container{{Name: "main", Image: "busybox"}}}}},
		}},
	}
	c, client, _ := newFakeConn(t, sts, ds, cj)
	m := managerWith(c, false)

	for _, w := range []struct{ kind, ns, name string }{{"apps/StatefulSet", "payments", "db"}, {"apps/DaemonSet", "kube-system", "agent"}} {
		if err := m.RestartWorkload("test", w.kind, w.ns, w.name); err != nil {
			t.Fatalf("restart %s: %v", w.kind, err)
		}
	}
	got, _ := client.AppsV1().StatefulSets("payments").Get(ctx, "db", metav1.GetOptions{})
	if got.Spec.Template.Annotations["kubectl.kubernetes.io/restartedAt"] == "" {
		t.Fatal("StatefulSet template not stamped")
	}
	gotDS, _ := client.AppsV1().DaemonSets("kube-system").Get(ctx, "agent", metav1.GetOptions{})
	if gotDS.Spec.Template.Annotations["kubectl.kubernetes.io/restartedAt"] == "" {
		t.Fatal("DaemonSet template not stamped")
	}
	if err := m.RestartWorkload("test", "batch/Job", "payments", "x"); err == nil {
		t.Fatal("a Job cannot be restarted")
	}

	name, err := m.TriggerCronJob("test", "payments", "nightly-report")
	if err != nil {
		t.Fatal(err)
	}
	job, err := client.BatchV1().Jobs("payments").Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(name, "nightly-report-manual-") || len(name) > 63 {
		t.Fatalf("job name = %q", name)
	}
	if job.Annotations["cronjob.kubernetes.io/instantiate"] != "manual" || job.Labels["team"] != "billing" {
		t.Fatalf("job meta = %+v", job.ObjectMeta)
	}
	if len(job.OwnerReferences) != 1 || job.OwnerReferences[0].UID != "cj-uid" || job.OwnerReferences[0].Kind != "CronJob" {
		t.Fatalf("owner = %+v", job.OwnerReferences)
	}
	if job.Spec.Template.Spec.Containers[0].Image != "busybox" {
		t.Fatalf("spec not copied: %+v", job.Spec)
	}

	if err := m.SetCronJobSuspended("test", "payments", "nightly-report", true); err != nil {
		t.Fatal(err)
	}
	gotCJ, _ := client.BatchV1().CronJobs("payments").Get(ctx, "nightly-report", metav1.GetOptions{})
	if gotCJ.Spec.Suspend == nil || !*gotCJ.Spec.Suspend {
		t.Fatal("CronJob not suspended")
	}

	ro := managerWith(c, true)
	if _, err := ro.TriggerCronJob("test", "payments", "nightly-report"); err != ErrReadOnly {
		t.Fatalf("read-only trigger err = %v", err)
	}
	if err := ro.RestartWorkload("test", "apps/StatefulSet", "payments", "db"); err != ErrReadOnly {
		t.Fatalf("read-only restart err = %v", err)
	}
}

func TestManualJobNameFitsLimit(t *testing.T) {
	cj := &batchv1.CronJob{ObjectMeta: metav1.ObjectMeta{Name: strings.Repeat("a", 52), Namespace: "x"}}
	if n := manualJob(cj, time.Now()).Name; len(n) > 63 {
		t.Fatalf("name %q is %d characters", n, len(n))
	}
}

func TestJobStatusListsAttempts(t *testing.T) {
	backoff := int32(2)
	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{Name: "migrate", Namespace: "payments"},
		Spec:       batchv1.JobSpec{BackoffLimit: &backoff, Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"batch.kubernetes.io/job-name": "migrate"}}},
		Status: batchv1.JobStatus{Failed: 3, Conditions: []batchv1.JobCondition{{
			Type: batchv1.JobFailed, Status: corev1.ConditionTrue, Reason: "BackoffLimitExceeded", Message: "Job has reached the specified backoff limit",
		}}},
	}
	start := metav1.NewTime(time.Now().Add(-10 * time.Minute))
	attempt := func(name string, age time.Duration, code int32) *corev1.Pod {
		return &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "payments", Labels: map[string]string{"batch.kubernetes.io/job-name": "migrate"}, CreationTimestamp: metav1.NewTime(time.Now().Add(-age))},
			Status: corev1.PodStatus{Phase: corev1.PodFailed, StartTime: &start, ContainerStatuses: []corev1.ContainerStatus{{
				Name: "main", State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: code, Reason: "Error", FinishedAt: metav1.NewTime(start.Add(30 * time.Second))}},
			}}},
		}
	}
	other := attempt("unrelated", time.Minute, 0)
	other.Labels = map[string]string{"batch.kubernetes.io/job-name": "other"}
	c, _, _ := newFakeConn(t, job, attempt("migrate-a", 9*time.Minute, 1), attempt("migrate-b", 5*time.Minute, 2), other)
	m := managerWith(c, false)
	st, err := m.JobStatus("test", "payments", "migrate")
	if err != nil {
		t.Fatal(err)
	}
	if st.Condition != "Failed" || st.Reason != "BackoffLimitExceeded" || st.BackoffLimit != 2 {
		t.Fatalf("status = %+v", st)
	}
	if len(st.Attempts) != 2 || st.Attempts[0].Pod != "migrate-b" || *st.Attempts[0].ExitCode != 2 || st.Attempts[0].Health != Failed || st.Attempts[0].Duration != "30s" {
		t.Fatalf("attempts = %+v", st.Attempts)
	}
	if st.Missing != 1 {
		t.Fatalf("missing = %d (3 failed, 2 pods left)", st.Missing)
	}
}

func TestWarningEventsWindowAndOrder(t *testing.T) {
	now := time.Now()
	ev := func(name string, age time.Duration, count int32) corev1.Event {
		return corev1.Event{
			ObjectMeta:     metav1.ObjectMeta{Name: name, Namespace: "payments"},
			InvolvedObject: corev1.ObjectReference{Kind: "Pod", Namespace: "payments", Name: name},
			Type:           "Warning", Reason: "BackOff", Message: " Back-off restarting failed container ", Count: count,
			LastTimestamp: metav1.NewTime(now.Add(-age)),
		}
	}
	out := warningEvents([]corev1.Event{ev("old", 2*time.Hour, 3), ev("new", time.Minute, 0), ev("mid", 10*time.Minute, 7)}, now, time.Hour)
	if len(out) != 2 || out[0].Name != "new" || out[1].Name != "mid" {
		t.Fatalf("events = %+v", out)
	}
	if out[0].Count != 1 || out[1].Count != 7 || out[0].Message != "Back-off restarting failed container" {
		t.Fatalf("counts/messages = %+v", out)
	}
	if all := warningEvents([]corev1.Event{ev("old", 2*time.Hour, 3)}, now, 0); len(all) != 1 {
		t.Fatal("window 0 keeps everything")
	}
}

func TestClusterWarningsFallsBackToNamespace(t *testing.T) {
	e := &corev1.Event{ObjectMeta: metav1.ObjectMeta{Name: "e", Namespace: "payments"}, Type: "Warning", Reason: "Failed", LastTimestamp: metav1.Now(),
		InvolvedObject: corev1.ObjectReference{Kind: "Pod", Namespace: "payments", Name: "a"}}
	c, client, _ := newFakeConn(t, e)
	c.fallbackNS = "payments"
	client.PrependReactor("list", "events", func(a k8stesting.Action) (bool, runtime.Object, error) {
		if a.GetNamespace() == "" {
			return true, nil, forbidden("events")
		}
		return false, nil, nil
	})
	m := managerWith(c, false)
	out, err := m.ClusterWarnings("test", 0)
	if err != nil {
		t.Fatal(err)
	}
	if out.Scope != "payments" || len(out.Events) != 1 || out.Events[0].Reason != "Failed" {
		t.Fatalf("out = %+v", out)
	}
}

func TestAccessMatrixForSelfAndBindings(t *testing.T) {
	crb := &rbacv1.ClusterRoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: "devs-view"},
		Subjects:   []rbacv1.Subject{{Kind: "Group", Name: "devs"}},
		RoleRef:    rbacv1.RoleRef{Kind: "ClusterRole", Name: "view"},
	}
	unrelated := &rbacv1.ClusterRoleBinding{ObjectMeta: metav1.ObjectMeta{Name: "ops"}, Subjects: []rbacv1.Subject{{Kind: "User", Name: "ops"}}, RoleRef: rbacv1.RoleRef{Kind: "ClusterRole", Name: "admin"}}
	c, client, _ := newFakeConn(t, crb, unrelated)
	client.PrependReactor("create", "selfsubjectreviews", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, &authnv1.SelfSubjectReview{Status: authnv1.SelfSubjectReviewStatus{UserInfo: authnv1.UserInfo{Username: "ada", Groups: []string{"devs"}}}}, nil
	})
	client.PrependReactor("create", "selfsubjectaccessreviews", func(a k8stesting.Action) (bool, runtime.Object, error) {
		ra := a.(k8stesting.CreateAction).GetObject().(*authzv1.SelfSubjectAccessReview).Spec.ResourceAttributes
		allowed := ra.Resource == "pods" && ra.Subresource == "" && (ra.Verb == "get" || ra.Verb == "list") && ra.Namespace == "payments"
		return true, &authzv1.SelfSubjectAccessReview{Status: authzv1.SubjectAccessReviewStatus{Allowed: allowed}}, nil
	})
	m := managerWith(c, false)
	res, err := m.AccessMatrix("test", AccessSubject{}, "payments")
	if err != nil {
		t.Fatal(err)
	}
	if res.User != "ada" || len(res.Allowed) != len(AccessRows) {
		t.Fatalf("res = %+v", res)
	}
	if res.Allowed[0][0] != "yes" || res.Allowed[0][1] != "yes" || res.Allowed[0][6] != "no" {
		t.Fatalf("pods row = %v", res.Allowed[0])
	}
	// pods/log only has get.
	if res.Allowed[1][0] != "no" || res.Allowed[1][1] != "n/a" {
		t.Fatalf("pods/log row = %v", res.Allowed[1])
	}
	if len(res.Bindings) != 1 || res.Bindings[0].Name != "devs-view" || res.Bindings[0].Via != "group devs" {
		t.Fatalf("bindings = %+v", res.Bindings)
	}

	if _, err := m.AccessMatrix("test", AccessSubject{Kind: "ServiceAccount", Name: "ci"}, "payments"); err == nil {
		t.Fatal("a ServiceAccount without a namespace must be refused")
	}
}

func selfSigned(t *testing.T, cn string, notAfter time.Time) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: cn}, NotBefore: time.Now().Add(-time.Hour), NotAfter: notAfter, DNSNames: []string{cn}}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func TestExpiryReadsCertificatesAndTokens(t *testing.T) {
	now := time.Now()
	soon := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "shop-tls", Namespace: "web"}, Type: corev1.SecretTypeTLS,
		Data: map[string][]byte{"tls.crt": selfSigned(t, "shop.example.com", now.Add(5*24*time.Hour+time.Hour)), "tls.key": []byte("secret")}}
	later := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "api-tls", Namespace: "web"}, Type: corev1.SecretTypeTLS,
		Data: map[string][]byte{"tls.crt": selfSigned(t, "api.example.com", now.Add(200*24*time.Hour))}}
	broken := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "broken", Namespace: "web"}, Type: corev1.SecretTypeTLS, Data: map[string][]byte{"tls.crt": []byte("nope")}}
	items := secretExpiry([]corev1.Secret{*later, *soon, *broken}, now)
	if len(items) != 2 {
		t.Fatalf("items = %+v", items)
	}
	for _, it := range items {
		if it.Name == "shop-tls" && (it.DaysLeft != 5 || it.Subject != "shop.example.com" || it.Namespace != "web") {
			t.Fatalf("shop-tls = %+v", it)
		}
	}

	claims := base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"system:serviceaccount:ci:deployer","exp":` + big.NewInt(now.Add(-48*time.Hour).Unix()).String() + `}`))
	cfg := &rest.Config{BearerToken: "e30." + claims + ".sig", TLSClientConfig: rest.TLSClientConfig{CertData: selfSigned(t, "ada", now.Add(30*24*time.Hour+time.Hour))}}
	creds := credentialExpiry(cfg, now)
	if len(creds) != 2 || creds[0].What != "Client certificate" || creds[0].DaysLeft != 30 || creds[1].What != "Bearer token" || creds[1].DaysLeft >= 0 || creds[1].Subject != "system:serviceaccount:ci:deployer" {
		t.Fatalf("credentials = %+v", creds)
	}
	if _, _, ok := jwtExpiry("not-a-jwt"); ok {
		t.Fatal("opaque tokens have no expiry")
	}

	// Through the manager: secrets sorted soonest first; values never in the report.
	c, _, _ := newFakeConn(t, later, soon)
	c.rest = &rest.Config{Host: "http://127.0.0.1:1"}
	m := managerWith(c, false)
	rep, err := m.Expiry("test")
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Items) != 2 || rep.Items[0].Name != "shop-tls" {
		t.Fatalf("report = %+v", rep)
	}
}

func forbidden(resource string) error {
	return apierrors.NewForbidden(schema.GroupResource{Resource: resource}, "", nil)
}
