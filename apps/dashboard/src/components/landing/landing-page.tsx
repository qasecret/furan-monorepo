import { LandingCapabilities } from "./landing-capabilities";
import { LandingFeatures } from "./landing-features";
import { LandingFinalCta } from "./landing-final-cta";
import { LandingFooter } from "./landing-footer";
import { LandingHero } from "./landing-hero";
import { LandingNav } from "./landing-nav";
import { LandingProductPreview } from "./landing-product-preview";
import { LandingSdk } from "./landing-sdk";
import { LandingWorksWith } from "./landing-works-with";

/**
 * Furan marketing landing — the public front door at `/`. Theme comes from the
 * root layout's ThemeProvider.
 *
 * Owns its own scroll: the app shell locks `body { overflow: hidden }`, so the
 * one-pager scrolls inside a full-height `overflow-y-auto` container. `scroll-pt`
 * offsets anchor targets below the fixed nav; `scroll-smooth` is neutralized by
 * the reduced-motion rule in globals.css.
 */
export function LandingPage() {
  return (
    <div className="h-dvh overflow-y-auto scroll-pt-24 scroll-smooth bg-white text-zinc-900 antialiased dark:bg-black dark:text-white">
      <LandingNav />
      <main>
        <LandingHero />
        <LandingProductPreview />
        <LandingWorksWith />
        <LandingFeatures />
        <LandingSdk />
        <LandingCapabilities />
        <LandingFinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
