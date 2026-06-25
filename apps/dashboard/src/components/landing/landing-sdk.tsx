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
    <section
      id="sdk"
      className="border-y border-zinc-200/70 bg-zinc-50/60 py-24 dark:border-zinc-900 dark:bg-zinc-950/50"
    >
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-14 px-4 lg:grid-cols-2">
        <Reveal>
          <h2 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-white md:text-5xl">
            Integrate in three lines
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-zinc-600 dark:text-zinc-400">
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
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  {bullet}
                </span>
              </li>
            ))}
          </ul>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-9 inline-flex items-center gap-1 font-medium text-brand-text transition-opacity hover:opacity-80"
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
  const c = {
    cm: "text-zinc-400 dark:text-zinc-500",
    kw: "text-brand-text",
    str: "text-emerald-600 dark:text-emerald-400",
    fn: "text-sky-600 dark:text-sky-400",
    pl: "text-zinc-700 dark:text-zinc-300",
  };
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div className="flex gap-1.5">
          <span className="h-3 w-3 rounded-full bg-red-400/80" />
          <span className="h-3 w-3 rounded-full bg-amber-400/80" />
          <span className="h-3 w-3 rounded-full bg-green-400/80" />
        </div>
        <span className="ml-3 font-mono text-xs text-zinc-500">
          PricingTest.kt
        </span>
      </div>
      <pre className="overflow-x-auto p-6 font-mono text-[13px] leading-relaxed">
        <code>
          <span className={c.cm}>{"// build.gradle.kts\n"}</span>
          <span className={c.pl}>{"implementation("}</span>
          <span className={c.str}>
            {'"io.github.qasecret:furan-selenium:4.0.0"'}
          </span>
          <span className={c.pl}>{")\n\n"}</span>
          <span className={c.cm}>{"// PricingTest.kt\n"}</span>
          <span className={c.kw}>{"val"}</span>
          <span className={c.pl}>{" eyes = "}</span>
          <span className={c.fn}>{"FuranEyes"}</span>
          <span className={c.pl}>{"()\n"}</span>
          <span className={c.pl}>{"eyes."}</span>
          <span className={c.fn}>{"open"}</span>
          <span className={c.pl}>{"(driver, "}</span>
          <span className={c.str}>{'"Web"'}</span>
          <span className={c.pl}>{", "}</span>
          <span className={c.str}>{'"Pricing page"'}</span>
          <span className={c.pl}>{")\n"}</span>
          <span className={c.pl}>{"eyes."}</span>
          <span className={c.fn}>{"checkWindow"}</span>
          <span className={c.pl}>{"("}</span>
          <span className={c.str}>{'"Pricing — full page"'}</span>
          <span className={c.pl}>{")  "}</span>
          <span className={c.cm}>{"// pixel + VLM + a11y\n"}</span>
          <span className={c.pl}>{"eyes."}</span>
          <span className={c.fn}>{"close"}</span>
          <span className={c.pl}>{"()"}</span>
        </code>
      </pre>
    </div>
  );
}
