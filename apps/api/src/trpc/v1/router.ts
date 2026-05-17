import { t } from "../trpc.js";

import { membersRouter } from "./members.js";
import { projectsRouter } from "./projects.js";
import { runsRouter } from "./runs.js";

export const appRouter = t.router({
  members: membersRouter,
  projects: projectsRouter,
  runs: runsRouter,
});

export type AppRouter = typeof appRouter;
