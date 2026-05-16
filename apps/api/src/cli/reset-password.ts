import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
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
    },
  });

  if (!values.email) {
    console.error("Usage: reset-password --email <email> [--password <pwd>]");
    process.exit(2);
  }

  let plain = values.password;
  if (!plain) {
    const rl = createInterface({ input, output });
    plain = await rl.question("New password: ");
    rl.close();
  }
  if (!plain || plain.length < 8) {
    console.error("Password must be at least 8 chars.");
    process.exit(2);
  }

  getEnv(envSchema);

  const { db, close } = createDb();
  try {
    const hashedPassword = await hashPassword(plain);
    const result = await db
      .update(users)
      .set({ hashedPassword })
      .where(eq(users.email, values.email))
      .returning({ id: users.id });
    if (result.length === 0) {
      console.error(`No user with email ${values.email}.`);
      process.exit(1);
    }
    console.log(`Reset password for ${values.email}.`);
  } finally {
    await close();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
