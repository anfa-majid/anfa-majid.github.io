export const siteConfig = {
  name: 'Anfa Majid',
  shortName: 'AM',
  githubUrl: 'https://github.com/anfa-majid',
  linkedinUrl: 'https://www.linkedin.com/in/anfamajid',
  email: 'anfamajid@hotmail.com',
  cvPdfUrl: '/Anfa-Majid-CV.pdf',
}

export const manuscripts = {
  completed: [
    {
      title: 'When Equal Forecast Error Is Not Operationally Equal',
      status: 'Complete · Unpublished',
      description:
        'A controlled study of how forecast direction, timing, duration, and shape affect Kubernetes scaling decisions, service reliability, and resource use even when conventional accuracy metrics are similar.',
      background:
        'Predictive autoscalers are often evaluated using aggregate measures such as MAE and RMSE. These scores summarize error magnitude, but they do not show whether an error occurs before a demand spike, after a transition, or across a replica capacity threshold. In Kubernetes, those differences can determine whether capacity becomes ready in time, whether latency objectives are missed, or whether resources are simply overprovisioned.',
      impact:
        'Cloud platforms use autoscaling to keep services responsive without paying for unnecessary idle capacity. A forecast can look accurate during offline evaluation and still request too little capacity before an important demand spike. Because Kubernetes Pods need time to become ready, that mistake can cause slow requests, failed requests, and service level objective violations. The opposite error can provision capacity that is never used. This work helps platform teams evaluate forecasts by their operational consequences and design safety mechanisms that balance reliability with infrastructure cost.',
      question:
        'When forecasts have similar conventional accuracy, why can they produce different scaling decisions, reliability outcomes, and resource costs?',
      topics: ['Kubernetes', 'Predictive autoscaling', 'Forecast evaluation', 'Cloud systems'],
      links: [
        {
          label: 'GitHub repository',
          url: 'https://github.com/anfa-majid/forecast-error-semantics-kubernetes-autoscaling',
        },
      ],
    },
  ],
  ongoing: [
    {
      title: 'Control-Aware Telemetry Manipulation Against Predictive Kubernetes Autoscaling',
      description:
        'An ongoing study of whether an attacker can manipulate the live telemetry or forecast input used by a predictive Kubernetes autoscaler to create greater operational harm, and whether an independent runtime safeguard can reduce that harm.',
      background:
        'Predictive autoscalers make infrastructure decisions from live signals that may be delayed, corrupted, or intentionally manipulated. Existing security approaches often focus on generic anomaly detection, training attacks, or broad controller protections. Less is understood about an attacker that knows how replica thresholds, controller timing, and Pod readiness interact and uses that knowledge to target the scaling decision itself.',
      question:
        'Under the same manipulation budget, can a causal control aware attack cause more service and capacity harm than a comparable attack that does not account for autoscaler behavior, and can an independent safeguard reduce that harm at an acceptable cost?',
      impact:
        'A successful attack against autoscaling inputs could leave an application without enough ready capacity during real demand, causing slow requests, failures, and service level objective violations. It could also force unnecessary scaling and increase infrastructure cost. The research aims to help platform teams understand this attack surface and design safeguards that remain useful when the attacker adapts, without creating excessive cost during normal operation.',
      topics: ['Kubernetes', 'Predictive autoscaling', 'Systems security', 'Control systems', 'Adversarial resilience'],
    },
  ],
}
