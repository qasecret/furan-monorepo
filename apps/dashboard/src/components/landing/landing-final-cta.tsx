import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { GITHUB_URL } from "./constants";
import { GithubIcon } from "./github-icon";
import { Reveal } from "./reveal";

import { Button } from "@/components/ui/button";

export function LandingFinalCta() {
  return (
    <section className="relative overflow-hidden py-32">
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--furan-glow)] blur-[130px]" />
      <Reveal className="relative z-10 mx-auto max-w-3xl px-4 text-center">
        <h2 className="text-4xl font-semibold tracking-tight text-zinc-950 dark:text-white md:text-6xl">
          Own your visual testing.
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-lg text-zinc-600 dark:text-zinc-400">
          Stop shipping visual bugs — and keep every screenshot on your own
          infrastructure while you do it.
        </p>
        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button
            asChild
            className="h-12 px-8 text-base shadow-[0_8px_30px_-10px_rgba(168,255,83,0.7)] transition-shadow hover:shadow-[0_12px_40px_-8px_rgba(168,255,83,0.75)]"
          >
            <Link href="/login">
              Sign in <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="secondary" className="h-12 px-7 text-base">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              <GithubIcon className="mr-2 h-4 w-4" /> View on GitHub
            </a>
          </Button>
        </div>
      </Reveal>
    </section>
  );
}
