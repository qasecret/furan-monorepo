import type { Metadata } from "next";

import { MembersTable, type MemberRow } from "./_components/members-table";

import { SetBreadcrumbs } from "@/app/(protected)/_components/set-breadcrumbs";
import { PageTour } from "@/components/tour/page-tour";
import { PageContainer } from "@/components/ui/page-container";
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
  // The (area)/layout.tsx renders the 403 Card for non-admins, but Next.js still
  // executes this page's RSC — so re-check the (request-cached, free) role and
  // bail BEFORE the admin-only /users fetch, restoring the pre-move ordering.
  if ((await getViewerRole()) !== "admin") return null;

  // The current user's id flags their own row ("(you)") + gates self-deactivation.
  // If it can't be resolved, bail rather than render the table with an empty id
  // (which would silently disable the self-row guard).
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
    <PageContainer>
      <div className="space-y-4">
        <SetBreadcrumbs
          items={[{ label: "Admin", href: "/admin" }, { label: "Members" }]}
        />
        <PageTour pageId="admin-members" steps={MEMBERS_PAGE_TOUR} />
        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          Manage user access. Admins can create users, change roles, and
          deactivate accounts.
        </p>
        <div id="members-table">
          <MembersTable
            initialUsers={members}
            currentUserId={me.data.id}
            allProjects={allProjects}
          />
        </div>
      </div>
    </PageContainer>
  );
}
