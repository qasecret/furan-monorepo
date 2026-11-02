/**
 * The docs portal pages the dashboard links to: the slug contract of the docs
 * portal spec (2026-11-01, §7). The portal is served same-origin at `/docs`
 * by every release image, so links are plain paths. A test checks each slug
 * still has its page under the repo's `docs/`.
 */
export const DOCS_SLUGS = [
  "getting-started/install",
  "getting-started/create-project",
  "getting-started/create-token",
  "getting-started/first-upload",
  "getting-started/first-baseline",
  "getting-started/first-diff",
  "sdk/kotlin",
  "sdk/rest",
  "integrations/github-actions",
] as const;

export type DocsSlug = (typeof DOCS_SLUGS)[number];

/** `/docs/<slug>`, or `/docs` for the portal home; `query` is appended. */
export function docsHref(
  slug?: DocsSlug,
  query?: Record<string, string>,
): string {
  const path = slug ? `/docs/${slug}` : "/docs";
  const search = query ? new URLSearchParams(query).toString() : "";
  return search ? `${path}?${search}` : path;
}
