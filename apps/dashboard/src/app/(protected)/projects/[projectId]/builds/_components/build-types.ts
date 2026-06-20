import type { RouterOutputs } from "@/lib/trpc";

/** A build row as returned by `trpc.builds.list` (inferred — no hand drift). */
export type BuildRowData = RouterOutputs["builds"]["list"]["items"][number];
