/**
 * What the portal's home page (src/pages/index.tsx) says and links to. It is
 * plain data so tests/landing.test.ts can check it against sidebars.ts: every
 * page in the sidebar except the overview must appear in a section, or the
 * home page quietly falls behind the docs.
 */

export interface LandingLink {
  label: string;
  /** A doc id from sidebars.ts; the page is served at `/<doc>`. */
  doc: string;
}

export interface LandingSection {
  title: string;
  summary: string;
  links: LandingLink[];
}

export interface TrustFact {
  title: string;
  text: string;
  /** A doc path (`/install/compose`) or a full URL. */
  to: string;
}

export interface Step {
  title: string;
  text: string;
}

export const trustFacts: TrustFact[] = [
  {
    title: "Runs on your servers",
    text: "Screenshots, baselines and review history stay in your Postgres and your S3-compatible or local storage.",
    to: "/runbooks/storage-backends",
  },
  {
    title: "Signed release images",
    text: "Every image is multi-arch, cosign-signed, scanned before release and ships with an SBOM.",
    to: "/install/compose",
  },
  {
    title: "Roles and an audit log",
    text: "Owner, admin, editor and guest roles with per-project membership. Admin changes and refused tokens are audited.",
    to: "/getting-started/create-project",
  },
  {
    title: "Scoped CI tokens",
    text: "Tokens are limited to uploads or reads, can be bound to one project, and expire after 90 days by default.",
    to: "/getting-started/create-token",
  },
  {
    title: "Row-level security",
    text: "An optional Postgres row-level security backstop keeps each project's data apart.",
    to: "/runbooks/rls-enable",
  },
  {
    title: "Open source",
    text: "Apache-2.0 licensed, with no license keys and no per-seat limits.",
    to: "https://github.com/qasecret/furan-monorepo/blob/main/LICENSE",
  },
];

export const steps: Step[] = [
  {
    title: "Capture",
    text: "Your existing Selenium, Playwright or Appium tests take screenshots with the Kotlin SDK, the JavaScript client or plain REST.",
  },
  {
    title: "Compare",
    text: "Furan diffs each screenshot against its approved baseline, pixel first, with optional AI descriptions of what changed and accessibility checks.",
  },
  {
    title: "Review",
    text: "A reviewer approves or rejects each change in the dashboard. Approved screenshots become the new baseline, and the pull request gets the verdict.",
  },
];

export const sections: LandingSection[] = [
  {
    title: "Getting started",
    summary:
      "From the one-file install to your first reviewed diff, in seven short pages.",
    links: [
      { label: "Install Furan", doc: "getting-started/install" },
      {
        label: "Sign in and create a project",
        doc: "getting-started/create-project",
      },
      { label: "Create a token", doc: "getting-started/create-token" },
      { label: "Send your first upload", doc: "getting-started/first-upload" },
      {
        label: "Approve your first baselines",
        doc: "getting-started/first-baseline",
      },
      { label: "Review your first diff", doc: "getting-started/first-diff" },
      { label: "Wire it into CI", doc: "getting-started/next-ci" },
    ],
  },
  {
    title: "Install and operate",
    summary:
      "Production installs, upgrades, HTTPS, storage, backups and data isolation.",
    links: [
      { label: "One-file install (evaluation)", doc: "install/one-file" },
      { label: "Production install (Compose)", doc: "install/compose" },
      {
        label: "Production deploy and upgrades",
        doc: "runbooks/production-deploy",
      },
      { label: "HTTPS on a domain", doc: "runbooks/reverse-proxy-tls" },
      { label: "Storage backends", doc: "runbooks/storage-backends" },
      { label: "Backup and restore", doc: "runbooks/restore-from-backup" },
      {
        label: "Upgrade notes: per-step review",
        doc: "runbooks/review-model-upgrade",
      },
      {
        label: "Upgrade notes: server reads",
        doc: "runbooks/server-reads-upgrade",
      },
      { label: "Row-level security", doc: "runbooks/rls-enable" },
    ],
  },
  {
    title: "Send screenshots",
    summary:
      "Capture from Selenium, Playwright, Appium or JavaScript, or upload over REST.",
    links: [
      { label: "Kotlin SDK", doc: "sdk/kotlin" },
      { label: "JavaScript / TypeScript", doc: "integrations/javascript" },
      { label: "REST API upload", doc: "sdk/rest" },
    ],
  },
  {
    title: "CI",
    summary: "Run on every pull request and post the result back to it.",
    links: [
      { label: "GitHub Actions", doc: "integrations/github-actions" },
      { label: "GitLab CI", doc: "integrations/gitlab-ci" },
      { label: "Jenkins", doc: "integrations/jenkins" },
      { label: "GitHub App", doc: "integrations/github-app" },
    ],
  },
  {
    title: "Troubleshooting",
    summary: "Fixes for first installs and for a server that is struggling.",
    links: [
      { label: "First-install problems", doc: "troubleshooting/first-install" },
      { label: "API down", doc: "runbooks/api-down" },
      { label: "Diff queue backlog", doc: "runbooks/diff-queue-backlog" },
    ],
  },
];
