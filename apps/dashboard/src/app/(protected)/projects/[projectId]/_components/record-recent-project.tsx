"use client";

import { useEffect } from "react";

import { recordRecentProject } from "@/lib/recent-projects";

/**
 * Headless: records the visited project for the command palette's Recent group.
 * Replaces the side-effect that lived in the (now-removed) ProjectHeader, keyed
 * on the route's project so direct/palette navigations are captured accurately.
 */
export function RecordRecentProject({
  projectId,
  name,
}: {
  projectId: string;
  name: string;
}) {
  useEffect(() => {
    recordRecentProject({ id: projectId, name });
  }, [projectId, name]);
  return null;
}
