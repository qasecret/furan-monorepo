import type { Metadata } from "next";

import { MembersTable, type MemberRow } from "./_components/members-table";

import { PageTour } from "@/components/tour/page-tour";
import { apiGet } from "@/lib/api-client";
import { getViewerRole } from "@/lib/get-viewer";

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

interface Project {
  id: string;
  name: string;
}

interface SearchParams {
  q?: string;
}

export default async function MembersPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  if ((await getViewerRole()) !== "admin") return null;

  const me = await apiGet<Me>("/users/me");
  if (!me.data) return null;

  const params: SearchParams =
    (await (searchParams ?? Promise.resolve({} as SearchParams))) ?? {};
  const q = params.q?.trim();
  const path = q
    ? `/users?limit=25&q=${encodeURIComponent(q)}`
    : `/users?limit=25`;
  const [list, projectList] = await Promise.all([
    apiGet<MemberRow[]>(path),
    apiGet<Project[]>("/projects"),
  ]);
  const members = list.data ?? [];
  const allProjects = projectList.data ?? [];

  return (
    <>
      <PageTour pageId="admin-members" steps={MEMBERS_PAGE_TOUR} />
      <div id="members-table">
        <MembersTable
          initialUsers={members}
          currentUserId={me.data.id}
          allProjects={allProjects}
        />
      </div>
    </>
  );
}
