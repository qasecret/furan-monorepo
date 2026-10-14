/**
 * The one helper for review-context state in the URL (spec §3.3): a
 * parse/serialize pair, the list-filter mappings, the link builders, and the
 * `useReviewContext()` hook. Import from here.
 *
 * It is two modules behind one door so a server component can parse its
 * `searchParams`: `review-context.ts` is pure, and `use-review-context.ts` is
 * a client module (React and `next/navigation` hooks). A server module may not
 * import hooks, so the hook must not share a file with `parseReviewContext`.
 */
export * from "@/lib/review-context";
export { useReviewContext } from "@/lib/use-review-context";
