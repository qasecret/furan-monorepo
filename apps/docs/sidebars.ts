import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

/**
 * The portal's structure (spec §3.1). It is explicit, so files can stay where
 * they are in `docs/`. Slugs under `getting-started/` are a contract with the
 * dashboard's links: change one only with a redirect. Runbooks get short
 * labels here; their own titles stay as they are for GitHub readers.
 */
const sidebars: SidebarsConfig = {
  docs: [
    "README",
    {
      type: "category",
      label: "Getting started",
      collapsed: false,
      items: [
        "getting-started/install",
        "getting-started/create-project",
        "getting-started/create-token",
        "getting-started/first-upload",
        "getting-started/first-baseline",
        "getting-started/first-diff",
        "getting-started/next-ci",
      ],
    },
    {
      type: "category",
      label: "Install and operate",
      collapsed: false,
      items: [
        "install/one-file",
        "install/compose",
        {
          type: "doc",
          id: "runbooks/production-deploy",
          label: "Production deploy and upgrades",
        },
        {
          type: "doc",
          id: "runbooks/reverse-proxy-tls",
          label: "HTTPS on a domain",
        },
        {
          type: "doc",
          id: "runbooks/storage-backends",
          label: "Storage backends",
        },
        {
          type: "doc",
          id: "runbooks/restore-from-backup",
          label: "Backup and restore",
        },
        {
          type: "doc",
          id: "runbooks/review-model-upgrade",
          label: "Upgrade notes: per-step review",
        },
        {
          type: "doc",
          id: "runbooks/server-reads-upgrade",
          label: "Upgrade notes: server reads",
        },
        { type: "doc", id: "runbooks/rls-enable", label: "Row-level security" },
      ],
    },
    {
      type: "category",
      label: "Send screenshots",
      collapsed: false,
      items: [
        "sdk/kotlin",
        {
          type: "doc",
          id: "integrations/javascript",
          label: "JavaScript / TypeScript",
        },
        "sdk/rest",
      ],
    },
    {
      type: "category",
      label: "CI",
      collapsed: false,
      items: [
        {
          type: "doc",
          id: "integrations/github-actions",
          label: "GitHub Actions",
        },
        { type: "doc", id: "integrations/jenkins", label: "Jenkins" },
        { type: "doc", id: "integrations/gitlab-ci", label: "GitLab CI" },
        {
          type: "doc",
          id: "integrations/github-app",
          label: "GitHub App",
        },
      ],
    },
    {
      type: "category",
      label: "Troubleshooting",
      collapsed: false,
      items: [
        "troubleshooting/first-install",
        { type: "doc", id: "runbooks/api-down", label: "API down" },
        {
          type: "doc",
          id: "runbooks/diff-queue-backlog",
          label: "Diff queue backlog",
        },
      ],
    },
  ],
};

export default sidebars;
