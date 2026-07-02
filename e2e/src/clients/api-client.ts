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
    if (opts.expect !== undefined) {
      if (res.status !== opts.expect) {
        throw new ApiError(res.status, method, path, body);
      }
    } else if (res.status < 200 || res.status >= 300) {
      throw new ApiError(res.status, method, path, body);
    }
    return { status: res.status, body: body as T };
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
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
