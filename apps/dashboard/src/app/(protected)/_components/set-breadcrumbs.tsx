"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { useBreadcrumbsStore } from "./use-breadcrumbs";

import type { BreadcrumbCrumb } from "@/components/ui/breadcrumbs";

/**
 * Publishes the current route's breadcrumb trail (tagged with the route it
 * belongs to) to the global store so the TopBar can render it. Render once per
 * page/layout with the server-known crumbs.
 *
 * The store records which pathname the trail was set for; the TopBar discards
 * it once the route changes, so the trail can never go stale on a page that
 * doesn't publish its own.
 */
export function SetBreadcrumbs({ items }: { items: BreadcrumbCrumb[] }) {
  const setItems = useBreadcrumbsStore((s) => s.setItems);
  const pathname = usePathname();
  const key = JSON.stringify(items);

  // `key` is the serialized form of `items`; depending on it (rather than the
  // array identity) keeps the effect stable across re-renders.
  useEffect(() => {
    if (pathname) setItems(items, pathname);
  }, [key, pathname, setItems]);

  return null;
}
