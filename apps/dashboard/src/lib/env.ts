import { z } from "zod";

const browserEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:3000"),
  /**
   * Workspace label rendered in the sidebar chip next to the Furan logo.
   * Visible-only string; doesn't gate any backend behavior. Defaults to
   * "Self-hosted" so single-install deployments read coherently; SaaS-shaped
   * deployments can override with the customer's org name.
   */
  NEXT_PUBLIC_WORKSPACE_NAME: z.string().min(1).default("Self-hosted"),
});

export const browserEnv = browserEnvSchema.parse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_WORKSPACE_NAME: process.env.NEXT_PUBLIC_WORKSPACE_NAME,
});
