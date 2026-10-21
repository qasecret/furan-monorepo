import { createServer } from "node:net";

/**
 * Host ports that belong to a developer's own stack: the API, the dashboard,
 * Postgres, Redis and MinIO. The harness's listeners never use them.
 */
export const FORBIDDEN_PORTS: readonly number[] = [
  3000, 3001, 5433, 6380, 9000,
];

const MAX_TRIES = 20;

/**
 * Binds port 0 on loopback, reads the port the OS chose and releases it.
 * Another process could take the port before the caller binds it; that window
 * is inherent to picking a port ahead of time.
 */
export function listenOnEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not read the ephemeral port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/**
 * A free port that is not one of FORBIDDEN_PORTS. `listen` is injectable for
 * tests; by default it asks the OS.
 */
export async function pickPort(
  listen: () => Promise<number> = listenOnEphemeralPort,
): Promise<number> {
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const port = await listen();
    if (!FORBIDDEN_PORTS.includes(port)) return port;
  }
  throw new Error(
    `could not find a free port outside ${FORBIDDEN_PORTS.join(", ")} in ${MAX_TRIES} tries`,
  );
}
