import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Project-scoped layout with a Builds / Runs / Settings tab strip.
 * Builds is the new default landing tab (see /projects/[id]/page.tsx redirect).
 *
 * Active-state highlighting is intentionally not done here — Next.js Server
 * Components can't read the current pathname. Per-tab pages add their own
 * "current" marker, or a client island can be wrapped later if needed.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const tabs: { href: string; label: string }[] = [
    { href: `/projects/${projectId}/builds`, label: "Builds" },
    { href: `/projects/${projectId}/runs`, label: "Runs" },
    { href: `/projects/${projectId}/settings`, label: "Settings" },
  ];

  return (
    <div className="space-y-4 p-6">
      <nav
        className="flex gap-1 border-b border-neutral-200"
        data-testid="project-tabs"
      >
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="px-3 py-2 text-sm text-neutral-700 hover:text-neutral-900 hover:bg-neutral-100 rounded-t-md"
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
