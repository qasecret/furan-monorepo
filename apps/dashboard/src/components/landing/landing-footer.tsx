import { MessageSquare } from "lucide-react";

import { BrandMark } from "./brand-mark";
import { GITHUB_URL } from "./constants";
import { GithubIcon } from "./github-icon";

const COLUMNS = [
  { title: "Product", links: ["Features", "Product tour", "SDK", "Changelog"] },
  {
    title: "Resources",
    links: ["Documentation", "API reference", "Runbooks", "Roadmap"],
  },
  { title: "Project", links: ["GitHub", "Releases", "License", "Security"] },
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
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                aria-label="Community"
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
                {col.links.map((link) => (
                  <li key={link}>
                    <a
                      href={GITHUB_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="transition-colors hover:text-zinc-950 dark:hover:text-white"
                    >
                      {link}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex flex-col items-center justify-between gap-4 border-t border-zinc-200 pt-8 text-sm text-zinc-500 dark:border-zinc-900 md:flex-row">
          <p>© {new Date().getFullYear()} Furan · Self-hosted and open.</p>
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-brand shadow-[0_0_8px_rgba(168,255,83,0.8)]" />
            All systems operational
          </span>
        </div>
      </div>
    </footer>
  );
}
