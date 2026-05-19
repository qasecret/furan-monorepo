import { t } from "../trpc.js";

import { buildsRouter } from "./builds.js";
import { installationsRouter } from "./installations.js";
import { membersRouter } from "./members.js";
import { projectsRouter } from "./projects.js";
import { runsRouter } from "./runs.js";

export const appRouter = t.router({
  builds: buildsRouter,
  installations: installationsRouter,
  members: membersRouter,
  projects: projectsRouter,
  runs: runsRouter,
});

export type AppRouter = typeof appRouter;
