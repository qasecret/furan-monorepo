import {
  FALLBACK_TOKEN_POLICY,
  type ProjectOption,
  type TokenPolicy,
  type TokenRow,
} from "../_components/token-grant";

import { apiGet } from "@/lib/api-client";

/**
 * What the token pages (Account → Tokens, Admin → API Keys) render: the
 * caller's tokens, the projects a new token can be bound to (`GET /projects`:
 * an admin's session lists every project, anyone else their member projects)
 * and what the operator allows. A failed fetch degrades to an empty list or
 * the api's default policy rather than failing the page.
 */
export async function loadTokenPage(): Promise<{
  tokens: TokenRow[];
  projects: ProjectOption[];
  policy: TokenPolicy;
}> {
  const [tokens, projects, policy] = await Promise.all([
    apiGet<TokenRow[]>("/account/tokens").catch(() => ({ data: null })),
    apiGet<ProjectOption[]>("/projects").catch(() => ({ data: null })),
    apiGet<TokenPolicy>("/account/token-policy").catch(() => ({ data: null })),
  ]);
  return {
    tokens: Array.isArray(tokens.data) ? tokens.data : [],
    projects: Array.isArray(projects.data)
      ? projects.data.map(({ id, name }) => ({ id, name }))
      : [],
    policy: policy.data ?? FALLBACK_TOKEN_POLICY,
  };
}
