import { App, Octokit } from "octokit";

/** Hard ceiling on any single GitHub API request. Without it, a partitioned or
 *  slow GitHub endpoint hangs the webhook worker's job indefinitely (backing up
 *  the delivery queue). Matches the 10s bound used for outbound webhooks. */
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

/**
 * `fetch` wrapper that enforces {@link GITHUB_REQUEST_TIMEOUT_MS} on every
 * Octokit request. Any caller/plugin-supplied signal is preserved by combining
 * it with the timeout via `AbortSignal.any`, so the request aborts on whichever
 * fires first.
 */
const timeoutFetch: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;
  return fetch(input, { ...init, signal });
};

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
    // Bound every GitHub API call the app + its installation octokits make.
    Octokit: Octokit.defaults({ request: { fetch: timeoutFetch } }),
  });
}
