import { MessageSquare } from "lucide-react";

import { BrandMark } from "./brand-mark";
import { GITHUB_URL } from "./constants";
import { GithubIcon } from "./github-icon";

/**
 * Footer link targets. In-page items (`#…`) scroll within the landing; external
 * items point at real repo destinations and open in a new tab.
 */
const COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "#features" },
      { label: "Product tour", href: "#preview" },
      { label: "SDK", href: "#sdk" },
      { label: "Changelog", href: `${GITHUB_URL}/releases` },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Documentation", href: GITHUB_URL },
      { label: "API reference", href: GITHUB_URL },
      { label: "Runbooks", href: `${GITHUB_URL}/tree/main/docs/runbooks` },
      { label: "Roadmap", href: GITHUB_URL },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "GitHub", href: GITHUB_URL },
      { label: "Releases", href: `${GITHUB_URL}/releases` },
      { label: "License", href: `${GITHUB_URL}/blob/main/LICENSE` },
      { label: "Security", href: `${GITHUB_URL}/security` },
    ],
  },
];

export function LandingFooter() {
  return (
    <footer className="border-t border-zinc-200 bg-zinc-50/50 pb-8 pt-16 dark:border-zinc-900 dark:bg-zinc-950/40">
      <div className="mx-auto max-w-6xl px-4">
        <div className="mb-14 grid grid-cols-2 gap-8 md:grid-cols-5">
          <div className="col-span-2">
            <BrandMark />
            <p className="mt-4 max-w-xs text-sm text-zinc-600 dark:text-zinc-400">
              Self-hosted visual regression testing. Catch every visual bug
              before your users do — on infrastructure you control.
            </p>
            <div className="mt-6 flex items-center gap-3">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                aria-label="GitHub"
                className="text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-white"
              >
                <GithubIcon className="h-5 w-5" />
              </a>
              <a
                href={`${GITHUB_URL}/discussions`}
                target="_blank"
                rel="noreferrer"
                aria-label="Discussions"
                className="text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-white"
              >
                <MessageSquare className="h-5 w-5" />
              </a>
            </div>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h4 className="mb-4 text-sm font-semibold text-zinc-950 dark:text-white">
                {col.title}
              </h4>
              <ul className="space-y-3 text-sm text-zinc-600 dark:text-zinc-400">
                {col.links.map((link) => {
                  const external = link.href.startsWith("http");
                  return (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        {...(external
                          ? { target: "_blank", rel: "noreferrer" }
                          : {})}
                        className="transition-colors hover:text-zinc-950 dark:hover:text-white"
                      >
                        {link.label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex flex-col items-center justify-between gap-4 border-t border-zinc-200 pt-8 text-sm text-zinc-500 dark:border-zinc-900 md:flex-row">
          <p>© {new Date().getFullYear()} Furan · Self-hosted and open.</p>
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full bg-brand shadow-[0_0_8px_rgba(168,255,83,0.8)]"
            />
            All systems operational
          </span>
        </div>
      </div>
    </footer>
  );
}
