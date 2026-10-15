"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  parseReviewContext,
  REVIEW_PARAM_NAMES,
  reviewContextParams,
  type ReviewContext,
} from "@/lib/review-context";

/**
 * The review context from the URL, and a setter that writes it back.
 *
 * The setter takes a patch: it is shallow-merged over the current context, so
 * `facets` replaces the facets as a whole and a key set to `undefined` clears
 * it. It goes through `router.replace` with `scroll: false` (a filter change
 * is not a navigation, §3.3), and leaves search params the context does not
 * own (`expand`, ...), their order, and the URL hash as they are. Patches
 * issued in the same tick compose.
 *
 * Import it from `@/lib/review-url`.
 */
export function useReviewContext(): [
  ReviewContext,
  (patch: Partial<ReviewContext>) => void,
] {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();

  const ctx = useMemo(
    () => parseReviewContext(new URLSearchParams(search)),
    [search],
  );

  // The newest query string we know of: the URL's, or the one the last patch
  // wrote before the router has re-rendered us with it.
  const latest = useRef(search);
  useEffect(() => {
    latest.current = search;
  }, [search]);

  const setContext = useCallback(
    (patch: Partial<ReviewContext>) => {
      const next = new URLSearchParams(latest.current);
      const wanted = reviewContextParams({
        ...parseReviewContext(next),
        ...patch,
      });
      // Change the context's params where they stand (`set` / `delete`), so the
      // rest of the query keeps its order; a new one is appended.
      for (const name of REVIEW_PARAM_NAMES) {
        if (wanted.has(name)) next.set(name, wanted.get(name) ?? "");
        else next.delete(name);
      }
      const qs = next.toString();
      latest.current = qs;
      // The hash is not part of the search params; carry it over so a
      // `#run-<id>` anchor survives a filter change.
      const hash = window.location.hash;
      router.replace(`${pathname}${qs ? `?${qs}` : ""}${hash}`, {
        scroll: false,
      });
    },
    [router, pathname],
  );

  return [ctx, setContext];
}
