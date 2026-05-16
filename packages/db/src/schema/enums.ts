import { pgEnum } from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", ["admin", "editor", "guest"]);
export const environmentEnum = pgEnum("environment", [
  "default",
  "staging",
  "prod",
]);
export const imageComparisonEnum = pgEnum("image_comparison", [
  "pixelmatch",
  "looks_same",
  "odiff",
]);
