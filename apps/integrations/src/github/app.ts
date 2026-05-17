import { App } from "octokit";

/**
 * Build a GitHub App client from the three env-supplied secrets.
 *
 * Caller is responsible for the all-or-nothing presence check — see
 * `envSchema` in `../env.ts`. This factory just wires the credentials into
 * an `octokit.App` instance, which lazily mints JWTs and per-installation
 * access tokens as the webhook handlers / commit-status updater need them.
 *
 * The `webhooks.secret` is what `app.webhooks.verifyAndReceive` uses to
 * HMAC-validate inbound POSTs (see `../fastify.ts`). If a secret rotation
 * is ever needed, redeploy with the new value — there's no live-reload
 * path for it in v1.0.
 */
export function createGitHubApp(env: {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_WEBHOOK_SECRET: string;
}): App {
  return new App({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    webhooks: { secret: env.GITHUB_APP_WEBHOOK_SECRET },
  });
}
