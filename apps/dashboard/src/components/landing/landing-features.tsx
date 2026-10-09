import {
  Accessibility,
  Brain,
  GitPullRequest,
  MonitorSmartphone,
  ScanEye,
  ShieldCheck,
} from "lucide-react";

import { Reveal } from "./reveal";

const FEATURES = [
  {
    icon: ScanEye,
    title: "Image-first pixel diff",
    desc: "A multi-engine pixel layer (odiff / pixelmatch / looks-same) with global-shift pre-alignment flags only the changes that matter — not anti-aliasing noise.",
  },
  {
    icon: Brain,
    title: "VLM smart layer",
    desc: "When pixels move, a vision-language model describes the change in plain English and points at the likely cause, so triage takes seconds, not minutes.",
  },
  {
    icon: MonitorSmartphone,
    title: "Cross-browser capture",
    desc: "Headless Playwright capture across viewports and devices, with per-screenshot element maps that localize every diff back to the DOM.",
  },
  {
    icon: Accessibility,
    title: "Accessibility built in",
    desc: "An axe-core pass surfaces WCAG violations as first-class regions on the same checkpoint — visual and a11y review live in one place.",
  },
  {
    icon: GitPullRequest,
    title: "PR review workflow",
    desc: "A GitHub App posts visual diffs straight onto your pull requests. Approve or reject baselines without ever leaving the review.",
  },
  {
    icon: ShieldCheck,
    title: "Self-hosted & private",
    desc: "Runs entirely on your own infrastructure via Docker — S3 or plain-disk storage. Screenshots and baselines never leave your network.",
  },
];

export function LandingFeatures() {
  return (
    <section id="features" className="py-24">
      <div className="mx-auto max-w-6xl px-4">
        <Reveal className="mx-auto mb-14 max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-fg md:text-5xl">
            Everything you need to ship with confidence
          </h2>
          <p className="mt-4 text-lg text-fg-secondary">
            A complete visual-testing platform — pixels, semantics, and
            accessibility — built for engineering teams that own their stack.
          </p>
        </Reveal>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature, i) => (
            <Reveal key={feature.title} delay={(i % 3) * 80}>
              <div className="group h-full rounded-2xl border border-edge bg-raised p-6 transition-all duration-200 hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-[0_12px_40px_-16px_rgba(168,255,83,0.35)]">
                <div className="mb-5 inline-flex h-11 w-11 items-center justify-center rounded-xl border border-edge bg-hover transition-colors group-hover:border-brand/50">
                  <feature.icon className="h-5 w-5 text-brand-text" />
                </div>
                <h3 className="mb-2 text-lg font-semibold text-fg">
                  {feature.title}
                </h3>
                <p className="text-sm leading-relaxed text-fg-secondary">
                  {feature.desc}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
