"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { useCurrentProject } from "./current-project-provider";

import { CreateProjectDialog } from "@/app/(protected)/projects/_components/create-project-dialog";
import { DocsLink } from "@/components/docs-link";
import { Card } from "@/components/ui/card";
import { useCommandRole } from "@/lib/commands/registry";
import { isAtLeastAdmin } from "@/lib/roles";

/**
 * Batches with no current project (first-run spec §4.1). An admin sees every
 * project but lands on one only through a default or a sole project
 * (ADR-052), so an admin here has none yet, or 2+ and no default: create the
 * first one, or choose one. Anyone else waits for an admin to add them.
 */
export function NoCurrentProject() {
  const role = useCommandRole();
  const { projects } = useCurrentProject();
  const admin = isAtLeastAdmin(role);

  return (
    <div
      className="flex flex-1 items-center justify-center p-10"
      data-testid="inbox-no-project"
    >
      <Card className="w-full max-w-md">
        <div className="space-y-3 p-2">
          {admin && projects.length === 0 ? (
            <>
              <h1 className="text-lg font-semibold text-fg">
                Create your first project
              </h1>
              <p className="text-sm text-fg-secondary">
                Projects hold your baselines and batches. Create one, then
                connect the SDK.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <CreateProjectDialog />
                <DocsLink
                  slug="getting-started/create-project"
                  className="text-sm text-brand-text hover:underline focus-ring"
                >
                  Creating a project
                </DocsLink>
              </div>
            </>
          ) : admin ? (
            <>
              <h1 className="text-lg font-semibold text-fg">
                Choose a project
              </h1>
              <p className="text-sm text-fg-secondary">
                Batches shows your default project, and you don&apos;t have one
                yet.
              </p>
              <ul className="divide-y divide-edge-subtle rounded-md border border-edge">
                {projects.map((p) => (
                  <li key={p.id}>
                    <Link
                      href={`/projects/${p.id}/builds`}
                      className="flex items-center gap-2 px-3 py-2 text-sm text-fg transition-colors hover:bg-hover focus-ring"
                    >
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <ChevronRight
                        className="h-4 w-4 shrink-0 text-fg-muted"
                        aria-hidden
                      />
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-fg-muted">
                To land here, set your default project in{" "}
                <Link
                  href="/admin/members"
                  className="text-brand-text hover:underline focus-ring"
                >
                  Admin → Members
                </Link>
                .
              </p>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold text-fg">
                No project assigned
              </h1>
              <p className="text-sm text-fg-secondary">
                Ask an admin to add you to a project.
              </p>
              <DocsLink
                slug="getting-started/install"
                className="text-sm text-brand-text hover:underline focus-ring"
              >
                Getting started
              </DocsLink>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
