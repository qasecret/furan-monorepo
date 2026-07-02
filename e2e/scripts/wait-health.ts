const API = process.env.E2E_API_URL ?? "http://localhost:3000";

interface ReadyBody {
  checks?: Record<string, string>;
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API}${path}`);
  const body: unknown = await res.json().catch(() => null);
  return { status: res.status, body };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Block until the api is live AND deeply ready (Postgres + Redis + S3 all "ok"),
 * or throw after `timeoutMs`. `/livez` first (process up), then the deep
 * `/readyz` (dependencies reachable) — mirrors the hardened probes.
 */
export async function waitHealthy(timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if ((await get("/livez")).status === 200) break;
    } catch {
      // api not accepting connections yet
    }
    await sleep(2_000);
  }

  while (Date.now() < deadline) {
    try {
      const { status, body } = await get("/readyz");
      const checks = (body as ReadyBody)?.checks ?? {};
      const values = Object.values(checks);
      if (status === 200 && values.length > 0 && values.every((v) => v === "ok")) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(2_000);
  }

  throw new Error(`api did not become healthy within ${timeoutMs}ms`);
}
