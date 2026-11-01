import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

/**
 * The portal's structure (spec §3.1). It is explicit, so files can stay where
 * they are in `docs/`. Slugs under `getting-started/` are a contract with the
 * dashboard's links: change one only with a redirect.
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
        "runbooks/production-deploy",
        "runbooks/reverse-proxy-tls",
        "runbooks/storage-backends",
        "runbooks/restore-from-backup",
        "runbooks/review-model-upgrade",
        "runbooks/rls-enable",
      ],
    },
    {
      type: "category",
      label: "Send screenshots",
      collapsed: false,
      items: ["sdk/kotlin", "sdk/rest"],
    },
    {
      type: "category",
      label: "CI",
      collapsed: false,
      items: ["integrations/github-actions"],
    },
    {
      type: "category",
      label: "Troubleshooting",
      collapsed: false,
      items: [
        "troubleshooting/first-install",
        "runbooks/api-down",
        "runbooks/diff-queue-backlog",
      ],
    },
  ],
};

export default sidebars;
