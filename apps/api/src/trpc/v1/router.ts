import { t } from "../trpc.js";

import { runsRouter } from "./runs.js";

export const appRouter = t.router({
  runs: runsRouter,
});

export type AppRouter = typeof appRouter;
