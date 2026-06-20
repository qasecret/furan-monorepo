import { inboxStatusFilter, inboxWindowFilter } from "@furan/shared-types";
import type { Metadata } from "next";

import { InboxPage } from "./_components/inbox-page";
import { INBOX_TOUR_STEPS } from "./tour-steps";

import { PageTour } from "@/components/tour/page-tour";

export const metadata: Metadata = { title: "Inbox" };

interface PageProps {
  searchParams: Promise<{ status?: string; window?: string; group?: string }>;
}

export default async function Page({ searchParams }: PageProps) {
  const sp = await searchParams;
  const status = inboxStatusFilter.safeParse(sp.status).data ?? "all-open";
  const window = inboxWindowFilter.safeParse(sp.window).data ?? "7d";
  const group = sp.group === "similarity";
  return (
    <>
      <PageTour pageId="inbox" steps={INBOX_TOUR_STEPS} />
      <InboxPage
        initialStatus={status}
        initialWindow={window}
        initialGroup={group}
      />
    </>
  );
}
