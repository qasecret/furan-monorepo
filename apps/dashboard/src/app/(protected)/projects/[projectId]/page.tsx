import { redirect } from "next/navigation";

/**
 * Builds is the new default landing tab for a project (see spec §3.8 and
 * the tab-strip layout sibling). Visiting `/projects/[id]` immediately
 * issues a 308 to `/projects/[id]/builds`.
 */
export default async function ProjectRootPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/builds`);
}
