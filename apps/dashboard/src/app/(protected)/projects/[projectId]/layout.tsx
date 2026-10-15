import type { ReactNode } from "react";

/**
 * Project-scoped layout: the column every project page fills. Each page
 * looks the project up itself (`getProject`) and renders its own error card
 * on a 403 / 404.
 */
export default function ProjectLayout({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col">{children}</div>;
}
