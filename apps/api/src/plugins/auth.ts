import fastifyJwt from "@fastify/jwt";
import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import { loadActiveUserByPat } from "../lib/load-active-user.js";
import { resolveAuthUser } from "../lib/resolve-auth-user.js";
import { isPatFormat } from "../lib/token.js";
import { touchTokenLastUsed } from "../lib/touch-token.js";

export type UserRole = "admin" | "editor" | "guest";

export interface AuthedUser {
  id: string;
  role: UserRole;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthedUser | null;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; role: UserRole };
    user: { sub: string; role: UserRole };
  }
}

export default fp(async (app) => {
  await app.register(fastifyJwt, {
    secret: app.env.JWT_SECRET,
    sign: { expiresIn: app.env.JWT_EXPIRY },
  });

  app.decorateRequest("auth", null);

  app.decorate(
    "authenticate",
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const bearer = extractBearer(req);
      const legacy = bearer ? null : extractLegacyApiKey(req);
      const raw = bearer ?? legacy;
      if (!raw) {
        return reply.code(401).send({ error: "missing_credentials" });
      }

      if (isPatFormat(raw)) {
        const pat = await loadActiveUserByPat(app.db, raw);
        if (!pat) {
          return reply.code(401).send({ error: "invalid_token" });
        }
        req.auth = { id: pat.id, role: pat.role };
        await touchTokenLastUsed(app.db, pat.tokenId);
        return;
      }

      // legacy apiKey header carrying a NON-PAT value is invalid
      // (JWTs go through Bearer).
      if (legacy && !bearer) {
        return reply.code(401).send({ error: "invalid_token_format" });
      }

      let payload: { sub: string };
      try {
        // Verify the token we extracted (Bearer header *or* furan_jwt
        // cookie). `req.jwtVerify()` only inspects the Authorization
        // header, so it would miss the cookie path — `app.jwt.verify`
        // takes the raw token explicitly. The role claim is intentionally
        // ignored — the live role comes from loadActiveUser below.
        payload = app.jwt.verify(raw) as { sub: string };
      } catch {
        return reply.code(401).send({ error: "invalid_jwt" });
      }

      // Reflect LIVE role/active state (cache → DB), not the up-to-7-day token
      // claim, so a demoted or deactivated user loses access on their next
      // request. A DB error propagates (500) rather than trusting the claim.
      const fresh = await resolveAuthUser(
        { db: app.db, cache: app.cache },
        payload.sub,
      );
      if (!fresh) {
        return reply.code(401).send({ error: "invalid_jwt" }); // missing/bad
      }
      if (!fresh.isActive) {
        // valid token, but the account is disabled — distinct from a bad token
        return reply.code(403).send({ error: "account_inactive" });
      }
      req.auth = { id: payload.sub, role: fresh.role };
    },
  );
});

// Cookie name the dashboard sets in apps/dashboard/src/lib/auth.ts. The api
// has to read it here because the dashboard's HttpOnly cookie is the only
// credential the browser can attach to cross-origin fetches (it can't
// reach into the cookie to forge an Authorization header, and exposing the
// JWT to JS would defeat the HttpOnly safety). CSRF surface is contained
// by the CORS allowlist + SameSite=Lax on the cookie.
const DASHBOARD_JWT_COOKIE = "furan_jwt";

function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers["authorization"];
  if (typeof h === "string") {
    const m = /^Bearer\s+(.+)$/.exec(h);
    if (m && m[1]) return m[1];
  }
  return extractDashboardCookie(req);
}

function extractDashboardCookie(req: FastifyRequest): string | null {
  const cookieHeader = req.headers["cookie"];
  if (typeof cookieHeader !== "string") return null;
  // Single-cookie regex is sufficient here — we only look for one name and
  // pulling in @fastify/cookie just for this would be overkill.
  const m = new RegExp(`(?:^|;\\s*)${DASHBOARD_JWT_COOKIE}=([^;]+)`).exec(
    cookieHeader,
  );
  if (!m || !m[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

function extractLegacyApiKey(req: FastifyRequest): string | null {
  const h = req.headers["apikey"];
  if (typeof h !== "string") return null;
  req.log.warn(
    { deprecation: "legacy_apikey_header" },
    "deprecated apiKey header used",
  );
  return h;
}
