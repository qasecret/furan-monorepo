import { type DB, users } from "@furan/db";

import { hashPassword } from "./password.js";

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

interface BootstrapEnv {
  FURAN_BOOTSTRAP_ADMIN_EMAIL?: string;
  FURAN_BOOTSTRAP_ADMIN_PASSWORD?: string;
}

/**
 * One-shot first-admin seed driven by env. Called from server.ts after
 * `createApp(...)` and before `app.listen(...)`. Never throws — the API
 * can still boot if seeding fails, so the operator can fall back to the
 * `seed-admin` CLI.
 */
export async function maybeBootstrapAdmin(
  db: DB,
  env: BootstrapEnv,
  log: Logger,
): Promise<void> {
  const email = env.FURAN_BOOTSTRAP_ADMIN_EMAIL;
  const password = env.FURAN_BOOTSTRAP_ADMIN_PASSWORD;

  if (!email && !password) return;

  if (!email || !password) {
    log.warn(
      { hasEmail: Boolean(email), hasPassword: Boolean(password) },
      "bootstrap_admin_partial_env_ignored",
    );
    return;
  }

  try {
    const existing = await db.select({ id: users.id }).from(users).limit(1);
    if (existing.length > 0) {
      log.info({ email }, "bootstrap_admin_skipped_users_exist");
      return;
    }

    const hashedPassword = await hashPassword(password);
    const inserted = await db
      .insert(users)
      .values({
        email,
        hashedPassword,
        firstName: "Admin",
        lastName: "User",
        role: "admin",
        isActive: true,
      })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });

    if (inserted[0]) {
      log.info({ email, id: inserted[0].id }, "bootstrap_admin_seeded");
    } else {
      log.info({ email }, "bootstrap_admin_already_seeded_by_peer");
    }
  } catch (err) {
    log.error({ err, email }, "bootstrap_admin_failed_continuing");
  }
}
