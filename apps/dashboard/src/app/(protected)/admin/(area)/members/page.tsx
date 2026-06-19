import type { Metadata } from "next";

import { MembersTable, type MemberRow } from "./_components/members-table";

import { SetBreadcrumbs } from "@/app/(protected)/_components/set-breadcrumbs";
import { PageTour } from "@/components/tour/page-tour";
import { apiGet } from "@/lib/api-client";

export const metadata: Metadata = { title: "Members" };

const MEMBERS_PAGE_TOUR = [
  {
    target: "#members-table",
    title: "User management",
    content:
      "Admins manage all users from here: create new ones, change roles (admin / editor / guest), or deactivate.",
    placement: "top" as const,
  },
];

export const dynamic = "force-dynamic";

interface Me {
  id: string;
  role: "admin" | "editor" | "guest";
}

interface SearchParams {
  q?: string;
}

export default async function MembersPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  // Admin access is enforced by the (area)/layout.tsx gate; here we only
  // need the current user's id to flag their own row ("(you)") in the table.
  const me = await apiGet<Me>("/users/me");

  const params: SearchParams =
    (await (searchParams ?? Promise.resolve({} as SearchParams))) ?? {};
  const q = params.q?.trim();
  const path = q
    ? `/users?limit=25&q=${encodeURIComponent(q)}`
    : `/users?limit=25`;
  const list = await apiGet<MemberRow[]>(path);
  const members = list.data ?? [];

  return (
    <div className="space-y-4">
      <SetBreadcrumbs items={[{ label: "Members" }]} />
      <PageTour pageId="admin-members" steps={MEMBERS_PAGE_TOUR} />
      <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
        Manage user access. Admins can create users, change roles, and
        deactivate accounts.
      </p>
      <div id="members-table">
        <MembersTable
          initialUsers={members}
          currentUserId={me.data?.id ?? ""}
        />
      </div>
    </div>
  );
}
