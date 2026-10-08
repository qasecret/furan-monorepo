/**
 * Thin typed client over the Furan REST API for E2E orchestration + tests.
 * All routes are at the ROOT (not `/api/v1`). Auth is `Authorization: Bearer`
 * with either a JWT (from /auth/login) or a `furan_pat_*` PAT.
 *
 * Every method throws `ApiError` on a non-2xx so a failed setup step fails loud
 * with the server's response body attached.
 */

export type Role = "owner" | "admin" | "editor" | "guest";

export interface User {
  id: string;
  email: string;
  role: Role;
  isActive?: boolean;
}

export interface LoginResult {
  token: string;
  user: User;
}

export interface Project {
  id: string;
  name: string;
  mainBranchName: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`${method} ${path} → ${status}: ${JSON.stringify(body)}`);
    this.name = "ApiError";
  }
}

interface RequestOpts {
  auth?: string;
  body?: unknown;
  /** Accept a non-2xx without throwing (e.g. probing an RBAC 403). */
  expect?: number;
  /** Never throw on any status — return {status, body} (backs `probe`). */
  noThrow?: boolean;
}

export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  async request<T>(
    method: string,
    path: string,
    opts: RequestOpts = {},
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.auth) headers["authorization"] = `Bearer ${opts.auth}`;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined
        ? { body: JSON.stringify(opts.body) }
        : {}),
    });
    const text = await res.text();
    const body: unknown = text ? safeJson(text) : null;
    if (!opts.noThrow) {
      if (opts.expect !== undefined) {
        if (res.status !== opts.expect) {
          throw new ApiError(res.status, method, path, body);
        }
      } else if (res.status < 200 || res.status >= 300) {
        throw new ApiError(res.status, method, path, body);
      }
    }
    return { status: res.status, body: body as T };
  }

  /** Like `request` but never throws on any status — returns {status, body} so a
   *  test can assert a gate outcome (403/409/...) directly. */
  async probe(
    method: string,
    path: string,
    opts: { auth?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: unknown }> {
    return this.request<unknown>(method, path, { ...opts, noThrow: true });
  }

  // ---- auth ---------------------------------------------------------------

  async loginJwt(email: string, password: string): Promise<LoginResult> {
    const { body } = await this.request<LoginResult>("POST", "/auth/login", {
      body: { email, password },
    });
    return body;
  }

  async me(auth: string): Promise<User> {
    const { body } = await this.request<User>("GET", "/users/me", { auth });
    return body;
  }

  /** Mint a `furan_pat_*` PAT for the authenticated principal. */
  async mintPat(auth: string, label: string): Promise<string> {
    const { body } = await this.request<{ token: string }>(
      "POST",
      "/account/tokens",
      { auth, body: { label } },
    );
    return body.token;
  }

  // ---- admin: users -------------------------------------------------------

  async createUser(
    admin: string,
    input: {
      email: string;
      password: string;
      firstName: string;
      lastName: string;
      role: Role;
    },
  ): Promise<User> {
    const { body } = await this.request<User>("POST", "/users", {
      auth: admin,
      body: input,
    });
    return body;
  }

  async updateUser(
    admin: string,
    id: string,
    patch: { role?: Role; isActive?: boolean },
  ): Promise<User> {
    const { body } = await this.request<User>("PATCH", `/users/${id}`, {
      auth: admin,
      body: patch,
    });
    return body;
  }

  // ---- admin: projects + membership --------------------------------------

  async createProject(
    admin: string,
    input: { name: string; mainBranchName?: string },
  ): Promise<Project> {
    const { body } = await this.request<Project>("POST", "/projects", {
      auth: admin,
      body: input,
    });
    return body;
  }

  /**
   * Call a tRPC mutation. Furan's tRPC uses RAW input (no superjson transformer)
   * and accepts the non-batch form: POST /trpc/<procedure> with the input as the
   * JSON body → `{ result: { data } }`.
   */
  async trpcMutate<T>(
    auth: string,
    procedure: string,
    input: unknown,
  ): Promise<T> {
    const { body } = await this.request<{ result: { data: T } }>(
      "POST",
      `/trpc/${procedure}`,
      { auth, body: input },
    );
    return body.result.data;
  }

  /** Create a project auto-rule (selector matcher). Returns the created row. */
  async createAutoRule(
    auth: string,
    input: {
      projectId: string;
      label: string;
      match: { type: "selector"; value: string };
      action: "auto_approve" | "flag";
      conditions?: { maxDiff?: number } | null;
    },
  ): Promise<{ id: string; enabled: boolean }> {
    return this.trpcMutate<{ id: string; enabled: boolean }>(
      auth,
      "autoRules.create",
      { conditions: null, ...input },
    );
  }

  /** Set per-project diff config (engine, auto-approve, thresholds, retention). */
  async setProjectConfig(
    admin: string,
    projectId: string,
    cfg: {
      imageComparison?: "odiff" | "pixelmatch" | "looks_same" | "vlm";
      autoApproveFeature?: boolean;
      diffThreshold?: number;
      retentionDays?: number;
    },
  ): Promise<Project> {
    return this.trpcMutate<Project>(admin, "projects.update", {
      projectId,
      ...cfg,
    });
  }

  async addMember(
    admin: string,
    projectId: string,
    userId: string,
  ): Promise<void> {
    await this.request("POST", `/projects/${projectId}/members`, {
      auth: admin,
      body: { userId },
      // 409 = already a member → idempotent, treat as success.
    }).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 409) return;
      throw e;
    });
  }

  /** Cross-branch baseline merge → synthetic build + fan-out of runs on toBranch. */
  async mergeBranches(
    auth: string,
    projectId: string,
    fromBranch: string,
    toBranch: string,
  ): Promise<{ buildId: string; runCount: number }> {
    const { body } = await this.request<{ buildId: string; runCount: number }>(
      "POST",
      `/projects/${projectId}/merge`,
      { auth, body: { fromBranch, toBranch } },
    );
    return body;
  }

  async listProjects(admin: string): Promise<Project[]> {
    const { body } = await this.request<Project[]>("GET", "/projects", {
      auth: admin,
    });
    return body;
  }

  async listUsers(admin: string): Promise<User[]> {
    const { body } = await this.request<User[]>("GET", "/users", {
      auth: admin,
    });
    return body;
  }

  // ---- SDK flow (build → run → screenshot → complete → poll) --------------

  async createBuild(
    auth: string,
    projectId: string,
    input: { branchName?: string; name?: string } = {},
  ): Promise<{ id: string }> {
    const { body } = await this.request<{ id: string }>(
      "POST",
      `/projects/${projectId}/builds`,
      { auth, body: input },
    );
    return body;
  }

  async createRun(
    auth: string,
    input: {
      projectId: string;
      buildId: string;
      name: string;
      branchName: string;
      parentBranchName?: string;
    },
  ): Promise<{ runId: string; status: string; name: string }> {
    const { body } = await this.request<{
      runId: string;
      status: string;
      name: string;
    }>("POST", "/runs", { auth, body: input });
    return body;
  }

  /** Upload one checkpoint screenshot via the base64 JSON variant (no multipart). */
  async uploadScreenshotBase64(
    auth: string,
    runId: string,
    input: {
      pngBase64: string;
      name: string;
      viewport: string;
      browser: string;
      domHtml?: string;
      elementMapJson?: string;
      ignoreDisplacements?: boolean;
    },
  ): Promise<{
    screenshotId: string;
    checkpointId: string;
    testVariationId: string;
  }> {
    const { body } = await this.request<{
      screenshotId: string;
      checkpointId: string;
      testVariationId: string;
    }>("POST", `/runs/${runId}/screenshots/base64`, { auth, body: input });
    return body;
  }

  /**
   * Upload a checkpoint screenshot via the MULTIPART endpoint, which (unlike the
   * base64 variant) accepts `matchLevel`, `domHtml`, and the axe a11y opts.
   */
  async uploadScreenshotMultipart(
    auth: string,
    runId: string,
    input: {
      png: Buffer;
      name: string;
      viewport: string;
      browser: string;
      matchLevel?: string;
      domHtml?: string;
      elementMapJson?: string;
      accessibilityLevel?: string;
      accessibilityVersion?: string;
    },
  ): Promise<{
    screenshotId: string;
    checkpointId: string;
    testVariationId: string;
  }> {
    const form = new FormData();
    form.append(
      "pngBytes",
      new Blob([input.png], { type: "image/png" }),
      "screenshot.png",
    );
    form.append("name", input.name);
    form.append("viewport", input.viewport);
    form.append("browser", input.browser);
    if (input.matchLevel) form.append("matchLevel", input.matchLevel);
    if (input.domHtml) form.append("domHtml", input.domHtml);
    if (input.elementMapJson) form.append("elementMapJson", input.elementMapJson);
    if (input.accessibilityLevel)
      form.append("accessibilityLevel", input.accessibilityLevel);
    if (input.accessibilityVersion)
      form.append("accessibilityVersion", input.accessibilityVersion);

    const res = await fetch(`${this.baseUrl}/runs/${runId}/screenshots`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}` },
      body: form,
    });
    const text = await res.text();
    const body: unknown = text ? safeJson(text) : null;
    if (res.status < 200 || res.status >= 300) {
      throw new ApiError(res.status, "POST", `/runs/${runId}/screenshots`, body);
    }
    return body as {
      screenshotId: string;
      checkpointId: string;
      testVariationId: string;
    };
  }

  async completeRun(auth: string, runId: string): Promise<void> {
    await this.request("POST", `/runs/${runId}/complete`, { auth });
  }

  /** Approve a run → promotes its screenshot to the variation's baseline. */
  async approveRun(auth: string, runId: string): Promise<void> {
    await this.request("POST", `/runs/${runId}/approve`, { auth });
  }

  /**
   * Approve a run AND persist reviewer-drawn ignore regions onto the variation
   * (ADR-036), so future runs mask those boxes. Uses the tRPC runs.approve (the
   * REST wrapper doesn't forward ignoreAreas).
   */
  async approveRunWithIgnore(
    auth: string,
    runId: string,
    ignoreAreas: {
      x: number;
      y: number;
      width: number;
      height: number;
      viewport: string;
      mode: "ignore" | "dynamic-text" | "strict";
    }[],
  ): Promise<void> {
    await this.trpcMutate(auth, "runs.approve", { runId, ignoreAreas });
  }

  async getRun(
    auth: string,
    runId: string,
  ): Promise<{ id: string; status: string; autoApproved?: boolean }> {
    const { body } = await this.request<{
      id: string;
      status: string;
      autoApproved?: boolean;
    }>("GET", `/runs/${runId}`, { auth });
    return body;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
