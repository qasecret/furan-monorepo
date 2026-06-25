import { buildAggregateStatusSchema } from "@furan/shared-types";
import type { Metadata } from "next";

import { InboxPage } from "./_components/inbox-page";
import { INBOX_TOUR_STEPS } from "./tour-steps";

import { PageTour } from "@/components/tour/page-tour";

export const metadata: Metadata = { title: "Batches" };

interface PageProps {
  searchParams: Promise<{ status?: string }>;
}

export default async function Page({ searchParams }: PageProps) {
  const sp = await searchParams;
  // `status` is a build aggregate status (passed/unresolved/…); absent → all.
  const status = buildAggregateStatusSchema.safeParse(sp.status).data ?? "all";
  return (
    <>
      <PageTour pageId="inbox" steps={INBOX_TOUR_STEPS} />
      <InboxPage initialStatus={status} />
    </>
  );
}
