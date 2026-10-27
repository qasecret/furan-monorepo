import type { DB } from "@furan/db";
import { describe, expect, test, vi } from "vitest";

import {
  gatedProjectOf,
  requireActionProject,
  requireBuildProject,
  requireRunProject,
  type Gated,
} from "../src/lib/review/actions.js";

/**
 * `ctx.gated` ties the membership gate's resolution to the resource it was
 * for (`{ kind, id, projectId }`, behind a `projectMember` gate with a
 * `lookup`). A handler trusts it only for the very resource it acts on; for
 * any other (another id, another kind, or no gate at all, as for an admin) it
 * reads the project itself, with the gate's own lookup.
 *
 * No database: the lookup is a fake `execute` that answers one project (or
 * none) and counts the reads.
 */

const RUN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/** A `db` whose every read finds `projectId` (none when null). */
function fakeDb(projectId: string | null) {
  const execute = vi.fn(() =>
    Promise.resolve(projectId === null ? [] : [{ project_id: projectId }]),
  );
  return { db: { execute } as unknown as DB, execute };
}

const gated = (kind: Gated["kind"], id: string): Gated => ({
  kind,
  id,
  projectId: "project-the-gate-resolved",
});

const helpers = {
  run: requireRunProject,
  build: requireBuildProject,
  action: requireActionProject,
} as const;

describe("gatedProjectOf", () => {
  test("the gate's project for the same kind and id; null for any other", () => {
    expect(gatedProjectOf(gated("run", RUN), "run", RUN)).toBe(
      "project-the-gate-resolved",
    );
    expect(gatedProjectOf(gated("run", OTHER), "run", RUN)).toBeNull();
    expect(gatedProjectOf(gated("build", RUN), "run", RUN)).toBeNull();
    expect(gatedProjectOf(gated("action", RUN), "run", RUN)).toBeNull();
    expect(gatedProjectOf(null, "run", RUN)).toBeNull();
  });
});

describe("require{Run,Build,Action}Project trust ctx.gated only for their own resource", () => {
  for (const [kind, require] of Object.entries(helpers)) {
    const k = kind as Gated["kind"];

    test(`${kind}: gated for this very ${kind}, nothing is read`, async () => {
      const { db, execute } = fakeDb("project-in-the-database");
      await expect(require(db, RUN, gated(k, RUN))).resolves.toBe(
        "project-the-gate-resolved",
      );
      expect(execute).not.toHaveBeenCalled();
    });

    test(`${kind}: a gated of another resource is ignored, and the project is read`, async () => {
      const others = [
        gated(k, OTHER),
        ...(["run", "build", "action"] as const)
          .filter((other) => other !== k)
          .map((other) => gated(other, RUN)),
        null,
      ];
      for (const g of others) {
        const { db, execute } = fakeDb("project-in-the-database");
        await expect(require(db, RUN, g)).resolves.toBe(
          "project-in-the-database",
        );
        expect(execute).toHaveBeenCalledTimes(1);
      }
    });

    test(`${kind}: one that is not there is NOT_FOUND, whatever another resource's gate said`, async () => {
      const { db } = fakeDb(null);
      await expect(require(db, RUN, gated(k, OTHER))).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });
  }
});
