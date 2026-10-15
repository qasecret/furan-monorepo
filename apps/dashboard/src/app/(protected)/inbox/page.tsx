import type { Metadata } from "next";

import { InboxPage } from "./_components/inbox-page";
import { INBOX_TOUR_STEPS } from "./tour-steps";

import { PageTour } from "@/components/tour/page-tour";
// The pure module, never the `review-url` barrel: this is a server component,
// and the barrel also re-exports the client hook.
import { parseReviewContext } from "@/lib/review-context";

export const metadata: Metadata = { title: "Batches" };

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function Page({ searchParams }: PageProps) {
  const sp = await searchParams;
  // The review context of the request (spec §3.3): the status chip (Needs
  // review when absent or invalid), the branch and the search. Bad input is
  // dropped silently; it never errors the page.
  const context = parseReviewContext(sp);
  return (
    <>
      <PageTour pageId="inbox" steps={INBOX_TOUR_STEPS} />
      <InboxPage context={context} />
    </>
  );
}
