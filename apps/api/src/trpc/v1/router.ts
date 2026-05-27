import { t } from "../trpc.js";

import { buildsRouter } from "./builds.js";
import { inboxRouter } from "./inbox.js";
import { installationsRouter } from "./installations.js";
import { membersRouter } from "./members.js";
import { projectsRouter } from "./projects.js";
import { runsRouter } from "./runs.js";
import { variationsRouter } from "./variations.js";

// Read INBOX_ENABLED directly from process.env so that this module can be
// imported before the full envSchema is validated (e.g. in tests, where
// JWT_SECRET and other required vars are set by helpers after import). The
// full schema validation happens in server.ts / createTestApp; here we only
// need a single boolean flag with a safe default.
const inboxEnabled = process.env.INBOX_ENABLED === "true";

export const appRouter = t.router({
  builds: buildsRouter,
  ...(inboxEnabled ? { inbox: inboxRouter } : {}),
  installations: installationsRouter,
  members: membersRouter,
  projects: projectsRouter,
  runs: runsRouter,
  variations: variationsRouter,
});

export type AppRouter = typeof appRouter;
