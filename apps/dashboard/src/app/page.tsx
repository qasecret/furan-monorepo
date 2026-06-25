import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LandingPage } from "@/components/landing/landing-page";
import { readJwt } from "@/lib/auth";

/**
 * Public front door at `/`.
 *
 * Returning users with a valid session skip the marketing page and land in the
 * app (the protected layout's requireJwt() still guards everything downstream);
 * signed-out visitors get the Furan landing. Route groups ((public)/(protected))
 * don't match the bare `/`, so this top-level page owns the decision.
 */
export const metadata: Metadata = {
  // `absolute` opts out of the root layout's "%s · Furan" template so the
  // marketing page gets a full, self-describing <title>.
  title: { absolute: "Furan — Self-hosted visual regression testing" },
  description:
    "Furan is self-hosted visual regression testing for modern teams: image-first pixel diffs, a VLM smart layer that explains what changed, and built-in accessibility checks — all on infrastructure you control.",
};

export default async function RootPage() {
  if (await readJwt()) redirect("/home");
  return <LandingPage />;
}
