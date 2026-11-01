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
      label: "Install and operate",
      collapsed: false,
      items: [
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
      label: "CI",
      collapsed: false,
      items: ["integrations/github-actions"],
    },
    {
      type: "category",
      label: "Troubleshooting",
      collapsed: false,
      items: ["runbooks/api-down", "runbooks/diff-queue-backlog"],
    },
  ],
};

export default sidebars;
