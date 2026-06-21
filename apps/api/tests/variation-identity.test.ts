// Side-effect import: registers the zod `.openapi()` extension that
// sdk-runs.ts's top-level request schemas rely on. App bootstrap does this
// via createApp; importing sdk-runs directly needs it loaded first.
import "../src/openapi/registry.js";

import { createDb, eq, projects, testVariations, type DB } from "@furan/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resolveOrCreateVariation } from "../src/routes/sdk-runs.js";

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

d(
  "resolveOrCreateVariation — the environment tuple IS the identity (ADR-054)",
  () => {
    let db: DB;
    let close: () => Promise<void>;
    let projectId: string;

    beforeAll(async () => {
      const created = createDb();
      db = created.db;
      close = created.close;
      const [p] = await db
        .insert(projects)
        .values({ name: `var-id-${Date.now()}` })
        .returning();
      projectId = p!.id;
    });

    afterAll(async () => {
      await db
        .delete(testVariations)
        .where(eq(testVariations.projectId, projectId));
      await db.delete(projects).where(eq(projects.id, projectId));
      await close();
    });

    beforeEach(async () => {
      await db
        .delete(testVariations)
        .where(eq(testVariations.projectId, projectId));
    });

    const base = (): {
      projectId: string;
      branchName: string;
      name: string;
      viewport: string;
      browser: string;
    } => ({
      projectId,
      branchName: "main",
      name: "home",
      viewport: "1280x720",
      browser: "chromium",
    });

    it("a null os and a concrete os are DISTINCT environments (no wildcard)", async () => {
      const win = await resolveOrCreateVariation(db, {
        ...base(),
        os: "Windows",
        device: null,
      });
      // Today this null-os lookup omits the os condition → wildcard-matches the
      // Windows variation. ADR-053/054: null is a distinct environment value.
      const nullOs = await resolveOrCreateVariation(db, {
        ...base(),
        os: null,
        device: null,
      });
      expect(nullOs.id).not.toBe(win.id);
    });

    it("a concrete os never collapses onto a null-os variation (reverse)", async () => {
      const nullOs = await resolveOrCreateVariation(db, {
        ...base(),
        os: null,
        device: null,
      });
      const win = await resolveOrCreateVariation(db, {
        ...base(),
        os: "Windows",
        device: null,
      });
      expect(win.id).not.toBe(nullOs.id);
    });

    it("the same concrete tuple resolves to the same variation (idempotent)", async () => {
      const a = await resolveOrCreateVariation(db, {
        ...base(),
        os: "macOS",
        device: null,
      });
      const b = await resolveOrCreateVariation(db, {
        ...base(),
        os: "macOS",
        device: null,
      });
      expect(b.id).toBe(a.id);
    });

    it("two null-os calls are idempotent (null is one value, not a fork)", async () => {
      const a = await resolveOrCreateVariation(db, {
        ...base(),
        os: null,
        device: null,
      });
      const b = await resolveOrCreateVariation(db, {
        ...base(),
        os: null,
        device: null,
      });
      expect(b.id).toBe(a.id);
    });

    it("distinct device values fork distinct variations", async () => {
      const phone = await resolveOrCreateVariation(db, {
        ...base(),
        os: null,
        device: "iPhone 15",
      });
      const noDevice = await resolveOrCreateVariation(db, {
        ...base(),
        os: null,
        device: null,
      });
      expect(phone.id).not.toBe(noDevice.id);
    });
  },
);
