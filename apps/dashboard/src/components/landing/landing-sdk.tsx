import { ArrowRight, Check } from "lucide-react";

import { GITHUB_URL } from "./constants";
import { Reveal } from "./reveal";

const BULLETS = [
  "Selenium, Playwright & Appium SDKs",
  "One shared API across every stack",
  "Native CI/CD & GitHub PR integration",
  "Drop-in to your existing test suite",
];

export function LandingSdk() {
  return (
    <section id="sdk" className="border-y border-edge/70 bg-sunken/60 py-24">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-14 px-4 lg:grid-cols-2">
        <Reveal>
          <h2 className="text-3xl font-semibold tracking-tight text-fg md:text-5xl">
            Integrate in three lines
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-fg-secondary">
            Add Furan to the test suite you already have. No new framework to
            learn, no infrastructure to babysit — open a checkpoint, snapshot,
            and let the engine do the rest.
          </p>
          <ul className="mt-8 space-y-3">
            {BULLETS.map((bullet) => (
              <li key={bullet} className="flex items-center gap-3">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand/15">
                  <Check className="h-3 w-3 text-brand-text" />
                </span>
                <span className="font-medium text-fg-secondary">{bullet}</span>
              </li>
            ))}
          </ul>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-9 inline-flex items-center gap-1 rounded-sm font-medium text-brand-text transition-opacity hover:opacity-80 focus-ring"
          >
            Read the documentation <ArrowRight className="h-4 w-4" />
          </a>
        </Reveal>

        <Reveal delay={120}>
          <CodeCard />
        </Reveal>
      </div>
    </section>
  );
}

/* Illustrative Kotlin / Selenium snippet — the SDK's checkpoint API. */
function CodeCard() {
  // Syntax colours must read at AA on the card in BOTH themes. No single
  // green/blue shade can (it would need luminance <= 0.18 for white and
  // >= 0.20 for the dark card), so strings and calls borrow the theme-aware
  // passed/running text tokens. They are not run statuses here.
  const c = {
    cm: "text-fg-muted",
    kw: "text-brand-text",
    str: "text-status-passed-text",
    fn: "text-status-running-text",
    // Plain code is primary text so comments (fg-muted) stay visibly quieter.
    pl: "text-fg",
  };
  return (
    <div className="overflow-hidden rounded-2xl bg-raised shadow-overlay">
      <div className="flex items-center gap-2 border-b border-edge bg-sunken px-4 py-3">
        <div className="flex gap-1.5">
          <span className="h-3 w-3 rounded-full bg-red-400/80" />
          <span className="h-3 w-3 rounded-full bg-amber-400/80" />
          <span className="h-3 w-3 rounded-full bg-green-400/80" />
        </div>
        <span className="ml-3 font-mono text-xs text-fg-muted">
          PricingTest.kt
        </span>
      </div>
      <pre className="overflow-x-auto p-6 font-mono text-xs leading-relaxed">
        <code>
          <span className={c.cm}>{"// build.gradle.kts\n"}</span>
          <span className={c.pl}>{"implementation("}</span>
          <span className={c.str}>
            {'"io.github.qasecret:furan-selenium:4.0.0"'}
          </span>
          <span className={c.pl}>{")\n\n"}</span>
          <span className={c.cm}>{"// PricingTest.kt\n"}</span>
          <span className={c.kw}>{"val"}</span>
          <span className={c.pl}>{" loupe = "}</span>
          <span className={c.fn}>{"Loupe"}</span>
          <span className={c.pl}>{"(config, driver)\n"}</span>
          <span className={c.pl}>{"loupe."}</span>
          <span className={c.fn}>{"open"}</span>
          <span className={c.pl}>{"("}</span>
          <span className={c.str}>{'"Web"'}</span>
          <span className={c.pl}>{", "}</span>
          <span className={c.str}>{'"Pricing page"'}</span>
          <span className={c.pl}>{")\n"}</span>
          <span className={c.pl}>{"loupe."}</span>
          <span className={c.fn}>{"check"}</span>
          <span className={c.pl}>{"("}</span>
          <span className={c.str}>{'"Pricing — full page"'}</span>
          <span className={c.pl}>{")  "}</span>
          <span className={c.cm}>{"// pixel + VLM + a11y\n"}</span>
          <span className={c.pl}>{"loupe."}</span>
          <span className={c.fn}>{"close"}</span>
          <span className={c.pl}>{"()"}</span>
        </code>
      </pre>
    </div>
  );
}
