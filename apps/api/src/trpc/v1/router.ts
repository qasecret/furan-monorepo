import { t } from "../trpc.js";

import { analyticsRouter } from "./analytics.js";
import { autoRulesRouter } from "./auto-rules.js";
import { baselinesRouter } from "./baselines.js";
import { buildsRouter } from "./builds.js";
import { inboxRouter } from "./inbox.js";
import { installationsRouter } from "./installations.js";
import { membersRouter } from "./members.js";
import { projectsRouter } from "./projects.js";
import { runsRouter } from "./runs.js";
import { variationsRouter } from "./variations.js";

export const appRouter = t.router({
  analytics: analyticsRouter,
  autoRules: autoRulesRouter,
  baselines: baselinesRouter,
  builds: buildsRouter,
  inbox: inboxRouter,
  installations: installationsRouter,
  members: membersRouter,
  projects: projectsRouter,
  runs: runsRouter,
  variations: variationsRouter,
});

export type AppRouter = typeof appRouter;
