import { t } from "../trpc.js";

import { membersRouter } from "./members.js";
import { runsRouter } from "./runs.js";

export const appRouter = t.router({
  members: membersRouter,
  runs: runsRouter,
});

export type AppRouter = typeof appRouter;
