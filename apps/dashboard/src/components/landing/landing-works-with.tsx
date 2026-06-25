import { Reveal } from "./reveal";

const TOOLS = ["Playwright", "Selenium", "Appium", "GitHub", "Slack", "Docker"];

/**
 * Honest "works with" band — the stacks Furan integrates with, as restrained
 * wordmarks rather than fabricated customer logos (this is a self-hosted OSS
 * tool, not a logo-wall SaaS).
 */
export function LandingWorksWith() {
  return (
    <section className="border-y border-zinc-200/70 bg-zinc-50/60 py-12 dark:border-zinc-900 dark:bg-zinc-950/40">
      <Reveal className="mx-auto max-w-6xl px-4">
        <p className="text-center font-mono text-xs uppercase tracking-widest text-zinc-500">
          Drops into the stack you already run
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-x-10 gap-y-5">
          {TOOLS.map((tool) => (
            <span
              key={tool}
              className="text-lg font-semibold tracking-tight text-zinc-400 transition-colors hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300"
            >
              {tool}
            </span>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
