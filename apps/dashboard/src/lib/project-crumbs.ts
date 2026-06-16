import type { BreadcrumbCrumb } from "@/components/ui/breadcrumbs";

/**
 * The shared `Projects › <name> › <tab>` breadcrumb trail for project-scoped
 * pages. One definition so the four tab pages can't drift on a nav change.
 */
export function projectCrumbs(
  projectId: string,
  projectName: string,
  leaf: string,
): BreadcrumbCrumb[] {
  return [
    { label: "Projects", href: "/projects" },
    { label: projectName, href: `/projects/${projectId}` },
    { label: leaf },
  ];
}
