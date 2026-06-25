import { ArrowRight, Sparkles } from "lucide-react";
import Link from "next/link";

import { Reveal } from "./reveal";

import { Button } from "@/components/ui/button";

const TERMINAL_LINES = [
  "$ furan run --browser chromium",
  "› capturing 42 checkpoints across 3 viewports",
  "› 2 visual changes detected · Pricing / Plan card",
  "› VLM: padding increased 16px → 24px on .cta-button",
  "› a11y: contrast 3.1:1 below WCAG AA on .badge",
  "$ furan baseline approve --build 1284",
  "› baseline updated on branch main ✓",
];

export function LandingHero() {
  return (
    <section className="relative overflow-hidden pt-36 pb-24">
      {/* dotted grid + radial brand glow */}
      <div className="bg-dotgrid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_55%,transparent_100%)]" />
      <div className="pointer-events-none absolute left-1/2 top-[-12%] h-[440px] w-[820px] -translate-x-1/2 rounded-full bg-[var(--furan-glow)] blur-[130px]" />
      {/* faint terminal artifact, desktop only */}
      <div className="pointer-events-none absolute inset-0 hidden select-none items-center justify-center opacity-[0.04] lg:flex">
        <pre className="-rotate-6 font-mono text-xs leading-7 text-zinc-900 dark:text-white">
          {TERMINAL_LINES.join("\n")}
        </pre>
      </div>

      <div className="relative z-10 mx-auto flex max-w-4xl flex-col items-center px-4 text-center">
        <Reveal>
          <a
            href="#features"
            className="group mb-7 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white/70 px-3 py-1.5 text-sm backdrop-blur transition-colors hover:border-brand/40 dark:border-zinc-800 dark:bg-zinc-900/50"
          >
            <span className="inline-flex items-center gap-1 rounded-full bg-brand/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-brand-text">
              <Sparkles className="h-3 w-3" /> New
            </span>
            <span className="text-zinc-600 dark:text-zinc-300">
              Image-first diffing with VLM root-cause
            </span>
            <ArrowRight className="h-3.5 w-3.5 text-zinc-400 transition-transform group-hover:translate-x-0.5" />
          </a>
        </Reveal>

        <Reveal delay={80}>
          <h1 className="text-balance text-5xl font-semibold leading-[1.05] tracking-tight text-zinc-950 dark:text-white md:text-7xl">
            Catch every visual regression.
            <br />
            <span className="bg-gradient-to-r from-zinc-500 to-zinc-900 bg-clip-text text-transparent dark:from-zinc-400 dark:to-white">
              Before your users do.
            </span>
          </h1>
        </Reveal>

        <Reveal delay={160}>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg text-zinc-600 dark:text-zinc-400 md:text-xl">
            Furan is self-hosted visual regression testing for modern teams.
            Pixel-perfect diffs, an AI smart layer that explains what changed,
            and built-in accessibility checks — all running on infrastructure
            you control.
          </p>
        </Reveal>

        <Reveal delay={240}>
          <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
            <Button
              asChild
              className="h-12 px-7 text-base shadow-[0_8px_30px_-10px_rgba(168,255,83,0.7)] transition-shadow hover:shadow-[0_12px_40px_-8px_rgba(168,255,83,0.75)]"
            >
              <Link href="/login">
                Sign in to your workspace
                <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="secondary" className="h-12 px-7 text-base">
              <a href="#preview">See it in action</a>
            </Button>
          </div>
        </Reveal>

        <Reveal delay={320}>
          <p className="mt-7 flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-zinc-500">
            <span className="h-1.5 w-1.5 rounded-full bg-brand shadow-[0_0_8px_rgba(168,255,83,0.8)]" />
            Self-hosted · Your data never leaves your infra
          </p>
        </Reveal>
      </div>
    </section>
  );
}
