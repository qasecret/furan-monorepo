import { parseArgs } from "node:util";

import { getEnv } from "@furan/config";
import { createDb, eq, users } from "@furan/db";

import { envSchema } from "../env.js";
import { hashPassword } from "../lib/password.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      password: { type: "string" },
      "first-name": { type: "string", default: "Admin" },
      "last-name": { type: "string", default: "User" },
    },
  });

  if (!values.email || !values.password) {
    console.error(
      "Usage: seed-admin --email <email> --password <password> [--first-name <n>] [--last-name <n>]",
    );
    process.exit(2);
  }

  getEnv(envSchema); // fails closed if env malformed

  const { db, close } = createDb();
  try {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, values.email))
      .limit(1);
    if (existing.length > 0) {
      console.log(`User ${values.email} already exists — no-op.`);
      return;
    }

    const hashedPassword = await hashPassword(values.password);
    const inserted = await db
      .insert(users)
      .values({
        email: values.email,
        hashedPassword,
        firstName: values["first-name"] ?? "Admin",
        lastName: values["last-name"] ?? "User",
        role: "admin",
        isActive: true,
      })
      .returning({ id: users.id });

    const row = inserted[0];
    if (!row) {
      throw new Error("Insert returned no row");
    }
    console.log(`Created admin ${values.email} (id=${row.id}).`);
  } finally {
    await close();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
