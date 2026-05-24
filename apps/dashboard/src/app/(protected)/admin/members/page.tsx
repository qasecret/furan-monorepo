import type { Metadata } from "next";

import { MembersTable, type MemberRow } from "./_components/members-table";

import { PageTour } from "@/components/tour/page-tour";
import { Card } from "@/components/ui/card";
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
  const me = await apiGet<Me>("/users/me");
  if (
    me.status === 401 ||
    me.status === 403 ||
    !me.data ||
    me.data.role !== "admin"
  ) {
    return (
      <Card>
        <h1 className="text-xl font-semibold text-white">403 — admin only</h1>
        <p className="text-sm text-zinc-400">
          You need the admin role to manage members.
        </p>
      </Card>
    );
  }

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
      <PageTour pageId="admin-members" steps={MEMBERS_PAGE_TOUR} />
      <h1 className="text-2xl font-semibold tracking-tight text-white">
        Members
      </h1>
      <p className="text-sm text-zinc-400">
        Manage user access. Admins can create users, change roles, and
        deactivate accounts.
      </p>
      <div id="members-table">
        <MembersTable initialUsers={members} currentUserId={me.data.id} />
      </div>
    </div>
  );
}
