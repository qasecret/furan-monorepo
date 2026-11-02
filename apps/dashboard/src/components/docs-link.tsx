import { ExternalLink } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";

import { docsHref, type DocsSlug } from "@/lib/docs-href";

type Props = {
  slug?: DocsSlug;
  query?: Record<string, string>;
  children: ReactNode;
} & Omit<ComponentPropsWithRef<"a">, "href" | "target" | "rel" | "children">;

/**
 * A link into the docs portal. A plain `<a>`, not Next's `<Link>`: the portal
 * is a separate static site, so it needs a full page load. It opens in a new
 * tab, so the values being copied from the dashboard stay on screen, and says
 * so to screen readers. The rest props reach the `<a>` (`ref` included), so a
 * Radix `asChild` item can wrap it.
 */
export function DocsLink({
  slug,
  query,
  children,
  className = "text-brand-text hover:underline focus-ring",
  ...rest
}: Props) {
  return (
    <a
      {...rest}
      href={docsHref(slug, query)}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {children}
      <ExternalLink
        className="ml-0.5 inline h-3 w-3 align-baseline"
        aria-hidden
      />{" "}
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
