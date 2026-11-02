import { readFileSync } from "node:fs";

import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import { themes as prismThemes } from "prism-react-renderer";

/**
 * The Furan documentation portal (ADR-081). One source, three builds:
 *
 *  - bundled: the dashboard image serves it at `/docs` (the defaults below);
 *  - releases: GitHub Pages, built with DOCS_BASE_URL=/furan-monorepo/ and
 *    DOCS_SITE_URL=https://qasecret.github.io by .github/workflows/docs.yml;
 *  - main: Cloudflare Pages at https://furan-docs.pages.dev, built by
 *    Cloudflare with DOCS_BASE_URL=/ (docs/maintainers/docs-hosting.md).
 *
 * Content is the repo's `docs/` folder, read in place; `docs/maintainers/`
 * stays on GitHub only. `trailingSlash: false` makes pages `x.html`, which
 * the dashboard's `/docs/:path+` → `/docs/:path+.html` rewrite relies on.
 */

const REPO = "https://github.com/qasecret/furan-monorepo";

// The released SDK version, from the file release-please bumps — the same
// source as the dashboard's FURAN_SDK_VERSION. Snippets render it through
// <SdkDependency>, so they never drift from Maven Central.
const sdkVersion = readFileSync(
  new URL("../../packages/sdk-kotlin/version.txt", import.meta.url),
  "utf8",
)
  .replace(/#.*$/m, "")
  .trim();

const config: Config = {
  title: "Furan",
  tagline: "Self-hosted visual regression testing",
  favicon: "img/furan-mark.svg",

  url: process.env.DOCS_SITE_URL ?? "http://localhost:8080",
  baseUrl: process.env.DOCS_BASE_URL ?? "/docs/",
  trailingSlash: false,

  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",
  markdown: {
    format: "detect",
    hooks: { onBrokenMarkdownLinks: "throw" },
  },

  i18n: { defaultLocale: "en", locales: ["en"] },

  customFields: { sdkVersion },

  presets: [
    [
      "classic",
      {
        docs: {
          path: "../../docs",
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          // Replaces the defaults, so the underscore partials are restated.
          exclude: ["maintainers/**", "**/_*.{md,mdx}", "**/_*/**"],
          // A string would be joined with the file's path relative to this
          // app (../../docs/…), which browsers collapse to /edit/docs/….
          editUrl: ({ docPath }) => `${REPO}/edit/main/docs/${docPath}`,
        },
        blog: false,
        pages: false,
        theme: { customCss: "./src/css/custom.css" },
      } satisfies Preset.Options,
    ],
  ],

  themes: [
    [
      "@easyops-cn/docusaurus-search-local",
      {
        hashed: true,
        indexBlog: false,
        docsRouteBasePath: "/",
        docsDir: "../../docs",
      },
    ],
  ],

  themeConfig: {
    colorMode: { respectPrefersColorScheme: true },
    navbar: {
      title: "Furan",
      logo: { alt: "Furan", src: "img/furan-mark.svg" },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docs",
          label: "Docs",
          position: "left",
        },
        { href: REPO, label: "GitHub", position: "right" },
      ],
    },
    footer: {
      style: "light",
      copyright: `Apache-2.0 · <a href="${REPO}">GitHub</a>`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["kotlin", "bash", "yaml", "json"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
