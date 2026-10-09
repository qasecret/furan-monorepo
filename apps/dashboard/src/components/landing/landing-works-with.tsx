import { Reveal } from "./reveal";

const TOOLS = ["Playwright", "Selenium", "Appium", "GitHub", "Slack", "Docker"];

/**
 * Honest "works with" band — the stacks Furan integrates with, as restrained
 * wordmarks rather than fabricated customer logos (this is a self-hosted OSS
 * tool, not a logo-wall SaaS).
 */
export function LandingWorksWith() {
  return (
    <section className="border-y border-edge/70 bg-sunken/60 py-12">
      <Reveal className="mx-auto max-w-6xl px-4">
        <p className="text-center font-mono text-xs uppercase tracking-widest text-fg-muted">
          Drops into the stack you already run
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-x-10 gap-y-5">
          {TOOLS.map((tool) => (
            <span
              key={tool}
              className="text-lg font-semibold tracking-tight text-fg-muted transition-colors hover:text-fg-secondary"
            >
              {tool}
            </span>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
