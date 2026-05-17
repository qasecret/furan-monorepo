import type { DB } from "@furan/db";
import type { Telemetry } from "@furan/telemetry";
import type { App } from "octokit";

import {
  deleteInstallation,
  getInstallation,
  upsertInstallation,
} from "./installation-store.js";

type Logger = Telemetry["logger"];

/**
 * `installation.account` is `simple-user | enterprise | null`. Only the
 * user shape carries `login`; enterprises identify by `slug`. We coerce
 * to "login | slug | ''" so the resulting string is always usable.
 */
function accountLoginOf(
  account:
    | { login?: string }
    | { slug?: string; name?: string }
    | null
    | undefined,
): string {
  if (!account) return "";
  if ("login" in account && typeof account.login === "string") {
    return account.login;
  }
  if ("slug" in account && typeof account.slug === "string") {
    return account.slug;
  }
  return "";
}

/**
 * Wire up the inbound GitHub App webhook handlers we care about for v1.0.
 *
 * Today: installation lifecycle (so we know which repos the App can act
 * on) + a minimal PR-event hook footprint that just logs. The actual
 * sticky-comment + status-check writes happen on `run.completed` from
 * the Redis pub/sub side (see ../run-events/subscriber.ts), not on PR
 * events — PRs flow into Furan via the SDK, not via webhooks.
 *
 * `pull_request.closed` + `merged === true` is a stub for the v1.1
 * baseline-promotion-on-merge feature (ADR-028 carved this out of v1.0);
 * we log a structured event so the telemetry trail exists when the
 * feature lands.
 */
export function registerWebhookHandlers(app: App, db: DB, log: Logger): void {
  app.webhooks.on("installation.created", async ({ payload }) => {
    const accountLogin = accountLoginOf(payload.installation.account);
    await upsertInstallation(db, {
      installationId: payload.installation.id,
      accountLogin,
      repositoryIds: (payload.repositories ?? []).map((r) => r.id),
    });
    log.info(
      {
        installationId: payload.installation.id,
        accountLogin,
        repoCount: payload.repositories?.length ?? 0,
      },
      "installation_created",
    );
  });

  app.webhooks.on("installation.deleted", async ({ payload }) => {
    await deleteInstallation(db, payload.installation.id);
    log.info(
      { installationId: payload.installation.id },
      "installation_deleted",
    );
  });

  app.webhooks.on(
    ["installation_repositories.added", "installation_repositories.removed"],
    async ({ payload }) => {
      const installationId = payload.installation.id;
      if (typeof installationId !== "number") {
        log.warn(
          { payloadType: "installation_repositories" },
          "installation_repositories_missing_id",
        );
        return;
      }
      const existing = await getInstallation(db, installationId);
      const current = new Set<number>(
        (existing?.repositoryIds ?? []).filter(
          (n): n is number => typeof n === "number",
        ),
      );
      for (const r of payload.repositories_added ?? []) {
        if (typeof r.id === "number") current.add(r.id);
      }
      for (const r of payload.repositories_removed ?? []) {
        if (typeof r.id === "number") current.delete(r.id);
      }
      await upsertInstallation(db, {
        installationId,
        accountLogin:
          accountLoginOf(payload.installation.account) ||
          existing?.accountLogin ||
          "",
        repositoryIds: [...current],
      });
      log.info(
        {
          installationId,
          added: payload.repositories_added?.length ?? 0,
          removed: payload.repositories_removed?.length ?? 0,
          total: current.size,
        },
        "installation_repositories_updated",
      );
    },
  );

  app.webhooks.on("pull_request.opened", ({ payload }) => {
    log.info(
      {
        prNumber: payload.pull_request.number,
        repo: payload.repository.full_name,
        headSha: payload.pull_request.head.sha,
      },
      "pr_opened",
    );
    // T8 just logs — Furan posts sticky comments + commit statuses
    // reactively on `run.completed`, not preemptively on PR open.
  });

  app.webhooks.on("pull_request.closed", ({ payload }) => {
    if (payload.pull_request.merged) {
      log.info(
        {
          prNumber: payload.pull_request.number,
          repo: payload.repository.full_name,
          mergeSha: payload.pull_request.merge_commit_sha,
        },
        "pr_merged_baseline_promotion_deferred_v11",
      );
      // TODO(v1.1): promote baseline of merged branch into target base.
    }
  });
}
