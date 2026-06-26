"use client";

import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { usePaletteStore } from "./use-command-palette";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { browserEnv } from "@/lib/env";
import { getRecentProjects, type RecentProject } from "@/lib/recent-projects";

interface Project {
  id: string;
  name: string;
}

// Style the cmdk group's heading slot only — putting these classes
// directly on `<Command.Group className>` propagates `uppercase` (and
// the other typography modifiers) down to the items, so every entry
// renders as ALL-CAPS. The `[&_[cmdk-group-heading]]:` arbitrary
// selector scopes them to the heading element cmdk emits inside the
// group wrapper.
const CMD_GROUP_CLASS =
  "[&_[cmdk-group-heading]]:text-xs " +
  "[&_[cmdk-group-heading]]:uppercase " +
  "[&_[cmdk-group-heading]]:tracking-wider " +
  "[&_[cmdk-group-heading]]:text-muted-foreground " +
  "[&_[cmdk-group-heading]]:px-2 " +
  "[&_[cmdk-group-heading]]:pt-2";

interface Props {
  /**
   * User role for conditional admin-only commands. Passed from the
   * Server-Component layout after a `/users/me` lookup so we don't
   * leak admin surfaces to editors/guests.
   */
  userRole: "admin" | "editor" | "guest";
}

/**
 * Global cmdk command palette.
 *
 * Open state lives in `usePaletteStore` (zustand) so the diff viewer's
 * tinykeys `/` handler can call `setOpen(true)` from outside React.
 *
 * Cmd+K / Ctrl+K is bound here at window level; we deliberately do NOT
 * delegate to tinykeys to avoid coupling to the diff-viewer-only
 * shortcut binding lifecycle.
 *
 * Projects are fetched lazily on open via the dashboard's `/projects`
 * REST endpoint (NOT tRPC) so the palette stays usable on Server-
 * Component-rendered pages that haven't yet wired the typed client.
 */
export function CommandPalette({ userRole }: Props) {
  const router = useRouter();
  const open = usePaletteStore((s) => s.open);
  const setOpen = usePaletteStore((s) => s.setOpen);
  const toggle = usePaletteStore((s) => s.toggle);
  const [projects, setProjects] = useState<Project[]>([]);
  const [recents, setRecents] = useState<RecentProject[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${browserEnv.NEXT_PUBLIC_API_URL}/projects`, {
          credentials: "include",
        });
        if (!res.ok) {
          if (!cancelled) setProjects([]);
          return;
        }
        const data = (await res.json()) as unknown;
        if (cancelled) return;
        if (Array.isArray(data)) {
          setProjects(data as Project[]);
        } else if (
          data &&
          typeof data === "object" &&
          "projects" in (data as Record<string, unknown>)
        ) {
          const arr = (data as { projects?: Project[] }).projects ?? [];
          setProjects(arr);
        } else {
          setProjects([]);
        }
      } catch {
        if (!cancelled) setProjects([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Recents are read from localStorage each time the palette opens so the list
  // reflects projects visited since the last open.
  useEffect(() => {
    if (open) setRecents(getRecentProjects());
  }, [open]);

  const go = (path: string) => {
    setOpen(false);
    router.push(path);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="p-0 overflow-hidden max-w-xl"
        data-testid="command-palette"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search projects, settings, and account pages.
        </DialogDescription>
        <Command label="Command palette" className="bg-popover">
          <Command.Input
            placeholder="Jump to…"
            className="w-full border-b px-4 py-3 text-sm outline-none bg-transparent"
            data-testid="command-input"
          />
          <Command.List className="max-h-80 overflow-auto p-1">
            <Command.Empty className="p-3 text-sm text-muted-foreground">
              No matches.
            </Command.Empty>

            {recents.length > 0 && (
              <Command.Group heading="Recent" className={CMD_GROUP_CLASS}>
                {recents.map((p) => (
                  <Command.Item
                    key={`recent-${p.id}`}
                    value={`recent ${p.name}`}
                    onSelect={() => go(`/projects/${p.id}/builds`)}
                    className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-accent data-[selected=true]:bg-accent"
                    data-testid={`cmd-recent-${p.id}`}
                  >
                    {p.name}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {projects.length > 0 && (
              <>
                <Command.Group heading="Projects" className={CMD_GROUP_CLASS}>
                  {projects.map((p) => (
                    <Command.Item
                      key={`project-${p.id}`}
                      value={`project ${p.name}`}
                      onSelect={() => go(`/projects/${p.id}/builds`)}
                      className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-accent data-[selected=true]:bg-accent"
                      data-testid={`cmd-project-${p.id}`}
                    >
                      Jump to project: {p.name}
                    </Command.Item>
                  ))}
                </Command.Group>
                <Command.Group
                  heading="Project settings"
                  className={CMD_GROUP_CLASS}
                >
                  {projects.map((p) => (
                    <Command.Item
                      key={`settings-${p.id}`}
                      value={`settings ${p.name}`}
                      onSelect={() => go(`/projects/${p.id}/settings`)}
                      className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-accent data-[selected=true]:bg-accent"
                      data-testid={`cmd-settings-${p.id}`}
                    >
                      Project settings: {p.name}
                    </Command.Item>
                  ))}
                </Command.Group>
              </>
            )}

            <Command.Group heading="Account" className={CMD_GROUP_CLASS}>
              <Command.Item
                value="api keys tokens"
                onSelect={() =>
                  go(
                    userRole === "admin"
                      ? "/admin/api-keys"
                      : "/account/tokens",
                  )
                }
                className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-accent data-[selected=true]:bg-accent"
                data-testid="cmd-api-keys"
              >
                {userRole === "admin" ? "/admin/api-keys" : "/account/tokens"}
              </Command.Item>
            </Command.Group>

            {userRole === "admin" && (
              <Command.Group heading="Admin" className={CMD_GROUP_CLASS}>
                <Command.Item
                  value="admin"
                  onSelect={() => go("/admin")}
                  className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-accent data-[selected=true]:bg-accent"
                  data-testid="cmd-admin"
                >
                  Admin
                  <span className="ml-auto text-xs text-zinc-500">/admin</span>
                </Command.Item>
                <Command.Item
                  value="admin members"
                  onSelect={() => go("/admin/members")}
                  className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-accent data-[selected=true]:bg-accent"
                  data-testid="cmd-admin-members"
                >
                  /admin/members
                </Command.Item>
                <Command.Item
                  value="admin installations github"
                  onSelect={() => go("/admin/installations")}
                  className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-accent data-[selected=true]:bg-accent"
                  data-testid="cmd-admin-installations"
                >
                  /admin/installations
                </Command.Item>
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
