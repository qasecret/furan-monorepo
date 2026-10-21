import { generateRawToken } from "@furan/api/scale";
import { tokens, type DB } from "@furan/db";

/**
 * The SDK's path in: a personal access token. This inserts one for `userId`
 * and returns the raw value, which lives in memory only (never printed,
 * never written down). The row goes with the scratch database.
 */
export async function seedPat(db: DB, userId: string): Promise<string> {
  const { raw, hash } = generateRawToken();
  await db.insert(tokens).values({ userId, label: "scale-harness", hash });
  return raw;
}

async function call<T>(
  pat: string,
  url: string,
  init: { method: "POST"; body?: FormData; json?: unknown },
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${pat}` };
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method: init.method,
    headers,
    ...(init.json !== undefined
      ? { body: JSON.stringify(init.json) }
      : init.body !== undefined
        ? { body: init.body }
        : {}),
  });
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    const route = new URL(url).pathname;
    throw new Error(
      `POST ${route} answered ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  return (text === "" ? null : JSON.parse(text)) as T;
}

export interface CreateRunInput {
  projectId: string;
  buildId: string;
  name: string;
  branchName: string;
  parentBranchName?: string;
}

/** `POST /runs`: a new run in an existing batch. */
export function createRun(
  apiUrl: string,
  pat: string,
  input: CreateRunInput,
): Promise<{ runId: string; status: string; name: string }> {
  return call(pat, `${apiUrl}/runs`, { method: "POST", json: input });
}

export interface UploadedStep {
  screenshotId: string;
  checkpointId: string;
  testVariationId: string;
}

/**
 * `POST /runs/:id/screenshots`: the multipart upload the SDK sends, one PNG per
 * step.
 */
export function uploadPng(
  apiUrl: string,
  pat: string,
  runId: string,
  step: { name: string; viewport: string; png: Uint8Array; browser?: string },
): Promise<UploadedStep> {
  const form = new FormData();
  form.append(
    "pngBytes",
    new Blob([step.png], { type: "image/png" }),
    "screenshot.png",
  );
  form.append("name", step.name);
  form.append("viewport", step.viewport);
  form.append("browser", step.browser ?? "chromium");
  return call(pat, `${apiUrl}/runs/${runId}/screenshots`, {
    method: "POST",
    body: form,
  });
}

/**
 * `POST /runs/:id/complete`: the SDK closing a run. The api stamps completion
 * only; the diff pipeline decides the verdict.
 */
export function complete(
  apiUrl: string,
  pat: string,
  runId: string,
): Promise<{ status?: string } | null> {
  return call(pat, `${apiUrl}/runs/${runId}/complete`, { method: "POST" });
}
