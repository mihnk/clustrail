export const locales = ['en', 'tr'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';

/** BCP 47 tags for `<html lang>` and `hreflang`. */
export const localeTags: Record<Locale, string> = { en: 'en', tr: 'tr' };

/** Shown in the language switcher, each in its own language. */
export const localeNames: Record<Locale, string> = { en: 'English', tr: 'Türkçe' };

// Product, project and Kubernetes names are not translated. Strings with
// markup (`<b>`, `<code>`) are trusted copy rendered with set:html.
export const ui = {
  en: {
    'site.title': 'Clustrail — Your Kubernetes workspace',
    'site.description':
      'Clustrail is a free, open-source Kubernetes desktop workspace for exploring, comparing and troubleshooting many clusters — with production safety built in.',
    'nav.label': 'Sections',
    'nav.clusters': 'Multi-cluster',
    'nav.safety': 'Production safety',
    'nav.investigate': 'Investigation',
    'nav.tools': 'Tools',
    'nav.oss': 'Open source',
    'nav.home': 'Clustrail home',
    'lang.label': 'Language',

    'hero.eyebrow': 'Free and open source · Desktop · macOS, Windows, Linux',
    'hero.title': 'Your Kubernetes <span>workspace.</span>',
    'hero.lead':
      'Explore, manage, compare and troubleshoot all your clusters from one fast desktop app. Production stays protected, problems surface first, and every feature is free.',
    'hero.follow': 'Follow on GitHub',
    'hero.how': 'See how it works',
    'hero.status':
      'In active development — the first public release is on its way. Watch the repository to hear when it ships.',
    'hero.shot':
      'Clustrail window showing Pods from three clusters, with a failing checkout-api pod open in the inspector',
    'hero.caption':
      'Design preview with sample data. Interface may change before the first release.',

    'why.eyebrow': 'What it’s for',
    'why.title': 'Built for the engineer who has five clusters open before lunch.',
    'why.see': 'See your clusters clearly',
    'why.see.1':
      'Select several clusters and browse them as one list, with a cluster column on every row.',
    'why.see.2': 'Unhealthy resources sort to the top. Healthy rows stay quiet.',
    'why.see.3': 'Thousands of resources stay fast with virtualized tables and live watches.',
    'why.investigate': 'Investigate problems quickly',
    'why.investigate.1': 'Open any resource in an inspector without losing your place.',
    'why.investigate.2': 'Events, logs, termination reasons and owners are one click away.',
    'why.investigate.3': 'Collect evidence into an investigation you can return to and share.',
    'why.operate': 'Operate production confidently',
    'why.operate.1': 'Production is marked on every screen, never by color alone.',
    'why.operate.2': 'Protected clusters show the impact of a change and ask you to type the name.',
    'why.operate.3': 'Viewing and changing are always separate actions.',

    'mc.eyebrow': 'Multi-cluster by design',
    'mc.title': 'Pick clusters once. Every view follows.',
    'mc.lead':
      'Clustrail treats a set of clusters as your working context. Pods, Deployments, Nodes and Events all show the selection together, or grouped by cluster when you need to tell them apart.',
    'mc.1': 'Clusters grouped as Production, Staging and Development.',
    'mc.2': 'Namespace is a filter, so it works across clusters with different namespaces.',
    'mc.3':
      'A cluster that drops out stays visible with its reason and a fix, instead of silently disappearing.',
    'mc.panel': 'Cluster picker with production, staging and development groups',
    'mc.selected': '3 of 6 selected',

    'ps.eyebrow': 'Production safety',
    'ps.title': 'Mistakes on production should be hard to make.',
    'ps.lead':
      'Each context gets a protection level. It is a safety net inside Clustrail; your cluster’s RBAC still decides what you can do.',
    'ps.standard': 'Standard',
    'ps.standard.text': 'Destructive actions ask once. Good for staging and development.',
    'ps.protected': 'Protected',
    'ps.protected.text':
      'Every change and every shell shows its impact, the equivalent <code>kubectl</code> command, and needs the resource name typed. The default for production.',
    'ps.readonly': 'Read-only',
    'ps.readonly.text':
      'Changes and shells are blocked in Clustrail. Logs, YAML and investigations still work.',
    'ps.1':
      'A hatched band and a {prod} tag follow production into every tab, terminal and dialog.',
    'ps.2':
      'Drain shows every pod it would evict, and which ones a PodDisruptionBudget will block, before anything runs.',
    'ps.3':
      'When a resource is managed by Argo CD or Flux, Clustrail warns that a direct edit will be reverted.',
    'ps.dialog': 'Confirmation dialog for restarting a production deployment',

    'iv.eyebrow': 'Investigation',
    'iv.title': 'Facts on one side. Your reasoning on the other.',
    'iv.lead':
      'When a Deployment starts failing, open an investigation. Clustrail gathers what the cluster reports: termination reasons, events, restarts, metrics and the log lines you pin. You write the hypotheses and link them to evidence.',
    'iv.1': 'Every fact names its source and when it was captured.',
    'iv.2':
      'Clustrail never guesses a root cause, and it says when Kubernetes no longer keeps the data you’d need.',
    'iv.3': 'Investigations are saved locally and export to Markdown for your incident notes.',
    'iv.panel':
      'Investigation with evidence from the cluster and a hypothesis written by the operator',

    'tl.eyebrow': 'Everyday tools',
    'tl.title': 'Everything you reach for, in one window.',
    'tl.logs': 'Logs',
    'tl.logs.text':
      'Merge pods into one stream, search and filter, read the previous container, and pause without losing lines.',
    'tl.term': 'Terminal',
    'tl.term.text':
      'Shells in tabs and splits, with cluster, pod and container always in view and reconnects handled.',
    'tl.yaml': 'YAML editor',
    'tl.yaml.text':
      'Folding, validation, side-by-side diff and server-side dry run before you apply.',
    'tl.compare': 'Environment compare',
    'tl.compare.text':
      'Staging against production: images, limits, env vars and HPA, showing only what differs.',
    'tl.workloads': 'Workloads',
    'tl.workloads.text':
      'Scale, restart and roll back Deployments with rollout history and related resources.',
    'tl.nodes': 'Nodes',
    'tl.nodes.text':
      'Conditions, allocation and taints, plus cordon and a drain preflight that lists every pod.',
    'tl.helm.text':
      'Releases, values, manifests and history across clusters, with rollback when you need it.',
    'tl.gitops.text':
      'Argo CD and Flux status, drift and errors, wherever a controller is installed.',

    'lf.eyebrow': 'Local-first',
    'lf.title': 'Your machine, your kubeconfig, your clusters.',
    'lf.lead':
      'Clustrail is a desktop app that talks straight to your API servers with the credentials you already use.',
    'lf.account': '<b>No account.</b> No sign-in, no email, nothing to register.',
    'lf.agents': '<b>No agents.</b> Nothing is installed in your clusters.',
    'lf.creds':
      '<b>No copied credentials.</b> Kubeconfig files are read in place and never edited.',
    'lf.telemetry':
      '<b>No telemetry.</b> Diagnostics are built locally and only shared if you choose.',
    'lf.git': '<b>No pushes to git.</b> GitOps views read controller status only.',
    'lf.diagnoses': '<b>No invented diagnoses.</b> What you see is what the cluster reports.',

    'os.eyebrow': 'Open source',
    'os.title': 'Every feature is free.',
    'os.lead':
      'No paid tier, no team plan, no locked features. Clustrail is developed in the open by mihnk, and contributions, bug reports and design feedback are welcome.',
    'os.star': 'Star on GitHub',
    'os.issue': 'Open an issue',
    'os.built': 'Built with',
    'os.stack':
      'A native desktop shell around a fast Go core. Lists are virtualized and log streams use bounded buffers, so large clusters stay responsive.',

    'fq.eyebrow': 'Questions',
    'fq.title': 'Good to know',
    'fq.free.q': 'Is it really free?',
    'fq.free.a':
      'Yes. Clustrail is open source under the Apache 2.0 license, and every feature is available to everyone, with no account or license key.',
    'fq.install.q': 'Do I need to install anything in my clusters?',
    'fq.install.a':
      'No. Clustrail uses the Kubernetes API with your existing kubeconfig. Usage graphs appear when metrics-server is available; Helm and GitOps views appear when those tools are present.',
    'fq.rbac.q': 'Does protected mode replace RBAC?',
    'fq.rbac.a':
      'No. Protection levels add confirmations and blocks inside Clustrail. What you are allowed to do is still decided by your cluster’s RBAC.',
    'fq.platforms.q': 'Which platforms will it support?',
    'fq.platforms.a':
      'macOS, Windows and Linux. Builds will be published with each release on GitHub.',
    'fq.languages.q': 'Which languages does the app speak?',
    'fq.languages.a':
      'English and Turkish. It follows your system language, and you can switch in Settings.',
    'fq.when.q': 'When can I try it?',
    'fq.when.a':
      'Clustrail is in active development. Watch the GitHub repository to be notified about the first release.',

    'footer.label': 'Footer',
    'footer.issues': 'Issues',
    'footer.note': 'A mihnk project · Apache-2.0',

    'notfound.title': 'Page not found — Clustrail',
    'notfound.heading': 'This page is off the route.',
    'notfound.text': 'The page you were looking for does not exist.',
    'notfound.home': 'Back to the start',
  },
  tr: {
    'site.title': 'Clustrail — Kubernetes çalışma alanınız',
    'site.description':
      'Clustrail, birçok cluster’ı keşfetmek, karşılaştırmak ve sorunlarını çözmek için ücretsiz ve açık kaynak bir Kubernetes masaüstü çalışma alanıdır; production güvenliği yerleşik gelir.',
    'nav.label': 'Bölümler',
    'nav.clusters': 'Çoklu cluster',
    'nav.safety': 'Production güvenliği',
    'nav.investigate': 'İnceleme',
    'nav.tools': 'Araçlar',
    'nav.oss': 'Açık kaynak',
    'nav.home': 'Clustrail ana sayfa',
    'lang.label': 'Dil',

    'hero.eyebrow': 'Ücretsiz ve açık kaynak · Masaüstü · macOS, Windows, Linux',
    'hero.title': 'Kubernetes <span>çalışma alanınız.</span>',
    'hero.lead':
      'Tüm cluster’larınızı tek bir hızlı masaüstü uygulamasından keşfedin, yönetin, karşılaştırın ve sorunlarını çözün. Production korunur, sorunlar ilk sırada görünür ve her özellik ücretsizdir.',
    'hero.follow': 'GitHub’da takip et',
    'hero.how': 'Nasıl çalıştığını gör',
    'hero.status':
      'Aktif olarak geliştiriliyor; ilk açık sürüm yolda. Çıktığında haberdar olmak için repoyu izleyin.',
    'hero.shot':
      'Üç cluster’ın Pod’larını gösteren Clustrail penceresi; hatalı checkout-api pod’u denetçide açık',
    'hero.caption': 'Örnek verilerle tasarım önizlemesi. Arayüz ilk sürümden önce değişebilir.',

    'why.eyebrow': 'Ne için',
    'why.title': 'Öğleden önce beş cluster açmış mühendis için yapıldı.',
    'why.see': 'Cluster’larınızı net görün',
    'why.see.1':
      'Birden fazla cluster seçin ve hepsini tek bir liste olarak gezin; her satırda cluster sütunu var.',
    'why.see.2': 'Sağlıksız kaynaklar en üste çıkar. Sağlıklı satırlar sessiz kalır.',
    'why.see.3': 'Sanal tablolar ve canlı watch’lar sayesinde binlerce kaynak hızlı kalır.',
    'why.investigate': 'Sorunları hızla inceleyin',
    'why.investigate.1': 'Herhangi bir kaynağı, yerinizi kaybetmeden bir denetçide açın.',
    'why.investigate.2': 'Event’ler, loglar, sonlanma nedenleri ve sahipler bir tık uzakta.',
    'why.investigate.3': 'Kanıtları, geri dönüp paylaşabileceğiniz bir incelemede toplayın.',
    'why.operate': 'Production’ı güvenle yönetin',
    'why.operate.1': 'Production her ekranda işaretlenir, asla yalnızca renkle değil.',
    'why.operate.2':
      'Korumalı cluster’lar bir değişikliğin etkisini gösterir ve adı yazmanızı ister.',
    'why.operate.3': 'Görüntülemek ve değiştirmek her zaman ayrı işlemlerdir.',

    'mc.eyebrow': 'Baştan çoklu cluster',
    'mc.title': 'Cluster’ları bir kez seçin. Her görünüm takip eder.',
    'mc.lead':
      'Clustrail bir grup cluster’ı çalışma bağlamınız olarak ele alır. Pod’lar, Deployment’lar, Node’lar ve Event’ler seçimi birlikte gösterir; ayırt etmeniz gerektiğinde cluster’a göre gruplar.',
    'mc.1': 'Cluster’lar Production, Staging ve Development olarak gruplanır.',
    'mc.2': 'Namespace bir filtredir; farklı namespace’leri olan cluster’larda da çalışır.',
    'mc.3': 'Düşen bir cluster sessizce kaybolmaz; nedeni ve çözümüyle görünür kalır.',
    'mc.panel': 'Production, staging ve development gruplarıyla cluster seçici',
    'mc.selected': '6 içinden 3 seçili',

    'ps.eyebrow': 'Production güvenliği',
    'ps.title': 'Production’da hata yapmak zor olmalı.',
    'ps.lead':
      'Her context’in bir koruma seviyesi vardır. Bu, Clustrail içindeki bir güvenlik ağıdır; ne yapabileceğinize yine cluster’ınızın RBAC’ı karar verir.',
    'ps.standard': 'Standart',
    'ps.standard.text': 'Yıkıcı işlemler bir kez onay ister. Staging ve development için uygundur.',
    'ps.protected': 'Korumalı',
    'ps.protected.text':
      'Her değişiklik ve her shell etkisini ve eşdeğer <code>kubectl</code> komutunu gösterir, kaynak adının yazılmasını ister. Production için varsayılan.',
    'ps.readonly': 'Salt okunur',
    'ps.readonly.text':
      'Değişiklikler ve shell’ler Clustrail’de engellenir. Loglar, YAML ve incelemeler yine çalışır.',
    'ps.1':
      'Taralı bir şerit ve {prod} etiketi production’ı her sekmeye, terminale ve diyaloğa kadar izler.',
    'ps.2':
      'Boşaltma (drain), hiçbir şey çalışmadan önce tahliye edeceği her pod’u ve bir PodDisruptionBudget’ın hangilerini engelleyeceğini gösterir.',
    'ps.3':
      'Bir kaynak Argo CD veya Flux tarafından yönetiliyorsa Clustrail, doğrudan düzenlemenin geri alınacağı konusunda uyarır.',
    'ps.dialog': 'Bir production deployment’ını yeniden başlatma onay diyaloğu',

    'iv.eyebrow': 'İnceleme',
    'iv.title': 'Bir yanda olgular. Öbür yanda sizin akıl yürütmeniz.',
    'iv.lead':
      'Bir Deployment hata vermeye başladığında bir inceleme açın. Clustrail cluster’ın bildirdiklerini toplar: sonlanma nedenleri, event’ler, yeniden başlatmalar, metrikler ve sabitlediğiniz log satırları. Hipotezleri siz yazar ve kanıtlara bağlarsınız.',
    'iv.1': 'Her olgu kaynağını ve ne zaman alındığını belirtir.',
    'iv.2':
      'Clustrail asla bir kök neden tahmin etmez ve Kubernetes ihtiyaç duyacağınız veriyi artık tutmuyorsa bunu söyler.',
    'iv.3': 'İncelemeler yerel olarak kaydedilir ve olay notlarınız için Markdown’a aktarılır.',
    'iv.panel': 'Cluster’dan gelen kanıtlar ve operatörün yazdığı bir hipotezle inceleme',

    'tl.eyebrow': 'Günlük araçlar',
    'tl.title': 'Uzandığınız her şey, tek pencerede.',
    'tl.logs': 'Loglar',
    'tl.logs.text':
      'Pod’ları tek akışta birleştirin, arayın ve filtreleyin, önceki container’ı okuyun, satır kaybetmeden duraklatın.',
    'tl.term': 'Terminal',
    'tl.term.text':
      'Sekmelerde ve bölmelerde shell’ler; cluster, pod ve container hep görünür, yeniden bağlanma halledilir.',
    'tl.yaml': 'YAML düzenleyici',
    'tl.yaml.text': 'Uygulamadan önce katlama, doğrulama, yan yana fark ve sunucu tarafı dry run.',
    'tl.compare': 'Ortam karşılaştırma',
    'tl.compare.text':
      'Staging ile production: image’lar, limitler, ortam değişkenleri ve HPA; yalnızca farklar.',
    'tl.workloads': 'İş yükleri',
    'tl.workloads.text':
      'Deployment’ları rollout geçmişi ve ilişkili kaynaklarla ölçekleyin, yeniden başlatın, geri alın.',
    'tl.nodes': 'Node’lar',
    'tl.nodes.text':
      'Koşullar, ayrımlar ve taint’ler; ayrıca cordon ve her pod’u listeleyen bir drain ön kontrolü.',
    'tl.helm.text':
      'Cluster’lar genelinde release’ler, değerler, manifest’ler ve geçmiş; gerektiğinde geri alma.',
    'tl.gitops.text':
      'Bir controller kurulu olan her yerde Argo CD ve Flux durumu, sapmalar ve hatalar.',

    'lf.eyebrow': 'Önce yerel',
    'lf.title': 'Sizin makineniz, sizin kubeconfig’iniz, sizin cluster’larınız.',
    'lf.lead':
      'Clustrail, zaten kullandığınız kimlik bilgileriyle doğrudan API sunucularınızla konuşan bir masaüstü uygulamasıdır.',
    'lf.account': '<b>Hesap yok.</b> Giriş yok, e-posta yok, kayıt olunacak bir şey yok.',
    'lf.agents': '<b>Ajan yok.</b> Cluster’larınıza hiçbir şey kurulmaz.',
    'lf.creds':
      '<b>Kopyalanan kimlik bilgisi yok.</b> Kubeconfig dosyaları yerinde okunur ve asla değiştirilmez.',
    'lf.telemetry':
      '<b>Telemetri yok.</b> Tanılama verisi yerelde oluşturulur ve yalnızca siz seçerseniz paylaşılır.',
    'lf.git': '<b>Git’e push yok.</b> GitOps görünümleri yalnızca controller durumunu okur.',
    'lf.diagnoses': '<b>Uydurma teşhis yok.</b> Gördüğünüz, cluster’ın bildirdiğidir.',

    'os.eyebrow': 'Açık kaynak',
    'os.title': 'Her özellik ücretsiz.',
    'os.lead':
      'Ücretli paket yok, ekip planı yok, kilitli özellik yok. Clustrail mihnk tarafından açık olarak geliştiriliyor; katkılar, hata bildirimleri ve tasarım geri bildirimleri memnuniyetle karşılanır.',
    'os.star': 'GitHub’da yıldızla',
    'os.issue': 'Issue aç',
    'os.built': 'Kullanılan teknolojiler',
    'os.stack':
      'Hızlı bir Go çekirdeği etrafında native bir masaüstü kabuğu. Listeler sanallaştırılır ve log akışları sınırlı arabellekler kullanır; büyük cluster’larda da akıcı kalır.',

    'fq.eyebrow': 'Sorular',
    'fq.title': 'Bilmekte fayda var',
    'fq.free.q': 'Gerçekten ücretsiz mi?',
    'fq.free.a':
      'Evet. Clustrail, Apache 2.0 lisansıyla açık kaynaktır ve her özellik herkese açıktır; hesap veya lisans anahtarı gerekmez.',
    'fq.install.q': 'Cluster’larıma bir şey kurmam gerekiyor mu?',
    'fq.install.a':
      'Hayır. Clustrail mevcut kubeconfig’inizle Kubernetes API’sini kullanır. metrics-server varsa kullanım grafikleri, Helm ve GitOps araçları varsa onların görünümleri çıkar.',
    'fq.rbac.q': 'Korumalı mod RBAC’ın yerini tutar mı?',
    'fq.rbac.a':
      'Hayır. Koruma seviyeleri Clustrail içinde onaylar ve engeller ekler. Ne yapmanıza izin verildiğine yine cluster’ınızın RBAC’ı karar verir.',
    'fq.platforms.q': 'Hangi platformları destekleyecek?',
    'fq.platforms.a': 'macOS, Windows ve Linux. Her sürümün derlemeleri GitHub’da yayınlanacak.',
    'fq.languages.q': 'Uygulama hangi dilleri konuşuyor?',
    'fq.languages.a':
      'İngilizce ve Türkçe. Sistem dilinizi izler; Ayarlar’dan değiştirebilirsiniz.',
    'fq.when.q': 'Ne zaman deneyebilirim?',
    'fq.when.a':
      'Clustrail aktif olarak geliştiriliyor. İlk sürümden haberdar olmak için GitHub reposunu izleyin.',

    'footer.label': 'Alt bilgi',
    'footer.issues': 'Issue’lar',
    'footer.note': 'Bir mihnk projesi · Apache-2.0',

    'notfound.title': 'Sayfa bulunamadı — Clustrail',
    'notfound.heading': 'Bu sayfa rotanın dışında.',
    'notfound.text': 'Aradığınız sayfa yok.',
    'notfound.home': 'Başa dön',
  },
} as const satisfies Record<Locale, Record<string, string>>;

export type UIKey = keyof (typeof ui)['en'];
