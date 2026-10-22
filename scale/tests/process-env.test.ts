import { envSchema } from "@furan/api/scale";
import { describe, expect, it } from "vitest";

import { parseScaleEnv } from "../src/env.js";
import { applyStackEnv, stackEnv } from "../src/stack/process-env.js";

const raw = {
  SCALE_DATABASE_URL: "postgres://admin:pw@localhost:55432/postgres",
  SCALE_REDIS_URL: "redis://localhost:56379",
  SCALE_S3_ENDPOINT: "http://localhost:59000",
  SCALE_S3_ACCESS_KEY: "ak",
  SCALE_S3_SECRET_KEY: "sk-long-enough",
};

describe("stackEnv", () => {
  it("points the api at the scratch database, never the admin one", () => {
    const env = parseScaleEnv(raw, { storage: "s3" });
    const out = stackEnv(
      env,
      "postgres://admin:pw@localhost:55432/furan_scale",
      {
        kind: "s3",
        bucket: "furan-scale-abcd1234",
      },
    );
    expect(new URL(out.DATABASE_URL!).pathname).toBe("/furan_scale");
    expect(out.REDIS_URL).toBe(raw.SCALE_REDIS_URL);
    expect(out.STORAGE_KIND).toBe("s3");
    expect(out.S3_BUCKET).toBe("furan-scale-abcd1234");
    expect(out.S3_ENDPOINT).toBe(raw.SCALE_S3_ENDPOINT);
    expect(out.LOG_LEVEL).toBe("warn");
    expect(out.JWT_SECRET).toMatch(/^[0-9a-f]{48}$/);
  });

  it("clears a DATABASE_URL_APP a dev shell may have set", () => {
    const env = parseScaleEnv(raw, { storage: "s3" });
    const out = stackEnv(
      env,
      "postgres://admin:pw@localhost:55432/furan_scale",
      {
        kind: "s3",
        bucket: "b",
      },
    );
    // `undefined` means: delete the variable from process.env.
    expect("DATABASE_URL_APP" in out).toBe(true);
    expect(out.DATABASE_URL_APP).toBeUndefined();
    expect(out.OTLP_ENDPOINT).toBeUndefined();
  });

  it("rewrites DATABASE_URL_APP onto the scratch database", () => {
    const env = parseScaleEnv(
      {
        ...raw,
        SCALE_DATABASE_URL_APP: "postgres://app:pw2@localhost:55432/postgres",
      },
      { storage: "s3" },
    );
    const out = stackEnv(
      env,
      "postgres://admin:pw@localhost:55432/furan_scale",
      {
        kind: "s3",
        bucket: "b",
      },
    );
    const app = new URL(out.DATABASE_URL_APP!);
    expect(app.pathname).toBe("/furan_scale");
    expect(app.username).toBe("app");
  });

  it("uses HDD_ROOT and clears the S3 settings for hdd storage", () => {
    const env = parseScaleEnv(
      {
        SCALE_DATABASE_URL: raw.SCALE_DATABASE_URL,
        SCALE_REDIS_URL: raw.SCALE_REDIS_URL,
      },
      { storage: "hdd" },
    );
    const out = stackEnv(
      env,
      "postgres://admin:pw@localhost:55432/furan_scale",
      {
        kind: "hdd",
        root: "/tmp/furan-scale-x",
      },
    );
    expect(out.STORAGE_KIND).toBe("hdd");
    expect(out.HDD_ROOT).toBe("/tmp/furan-scale-x");
    expect(out.S3_BUCKET).toBeUndefined();
    expect(out.S3_SECRET_KEY).toBeUndefined();
  });

  it("makes a new secret each time", () => {
    const env = parseScaleEnv(raw, { storage: "s3" });
    const loc = { kind: "s3", bucket: "b" } as const;
    const url = "postgres://admin:pw@localhost:55432/furan_scale";
    expect(stackEnv(env, url, loc).JWT_SECRET).not.toBe(
      stackEnv(env, url, loc).JWT_SECRET,
    );
  });
});

describe("the api's configuration does not depend on the caller's shell", () => {
  const scratch = "postgres://admin:pw@localhost:55432/furan_scale";
  const loc = { kind: "s3", bucket: "furan-scale-abcd1234" } as const;

  /** A shell that was set up for a dev stack, with every api knob turned. */
  const devShell = (): NodeJS.ProcessEnv => ({
    PATH: "/usr/bin",
    NODE_ENV: "production",
    PORT: "3000",
    HOST: "0.0.0.0",
    TRUST_PROXY: "true",
    SSE_MAX_CONNECTIONS: "1",
    JWT_EXPIRY: "1s",
    FURAN_DASHBOARD_ORIGIN: "https://dashboard.example",
    FURAN_BOOTSTRAP_ADMIN_EMAIL: "admin@example.com",
    FURAN_BOOTSTRAP_ADMIN_PASSWORD: "not-a-real-password",
    DATABASE_URL: "postgres://dev:dev@localhost:5433/furan",
    DATABASE_URL_APP: "postgres://app:dev@localhost:5433/furan",
    OTLP_ENDPOINT: "http://localhost:4318",
    LOG_LEVEL: "debug",
  });

  it("has none of TRUST_PROXY or SSE_MAX_CONNECTIONS in the stack env", () => {
    const env = parseScaleEnv(raw, { storage: "s3" });
    const out = stackEnv(env, scratch, loc);
    // Present as a key with no value: "remove it".
    for (const key of ["TRUST_PROXY", "SSE_MAX_CONNECTIONS", "NODE_ENV"]) {
      expect(key in out).toBe(true);
      expect(out[key]).toBeUndefined();
    }
  });

  it("leaves the api on its schema defaults after the env is applied", () => {
    const env = parseScaleEnv(raw, { storage: "s3" });
    const shell = devShell();
    applyStackEnv(env, scratch, loc, shell);

    expect(shell.TRUST_PROXY).toBeUndefined();
    expect(shell.SSE_MAX_CONNECTIONS).toBeUndefined();
    const api = envSchema.parse(shell);
    expect(api).toMatchObject({
      NODE_ENV: "development",
      PORT: 3000,
      HOST: "0.0.0.0",
      JWT_EXPIRY: "7d",
      SSE_MAX_CONNECTIONS: 10000,
      FURAN_DASHBOARD_ORIGIN: "http://localhost:3001",
      LOG_LEVEL: "warn",
    });
    expect(api.TRUST_PROXY).toBeUndefined();
    expect(api.OTLP_ENDPOINT).toBeUndefined();
    expect(api.DATABASE_URL_APP).toBeUndefined();
    expect(api.FURAN_BOOTSTRAP_ADMIN_EMAIL).toBeUndefined();
    expect(new URL(api.DATABASE_URL).pathname).toBe("/furan_scale");
  });

  it("covers every variable the api schema reads, so a new one cannot leak in", () => {
    const env = parseScaleEnv(raw, { storage: "s3" });
    const out = stackEnv(env, scratch, loc);
    for (const key of Object.keys(envSchema.shape)) {
      expect(key in out).toBe(true);
    }
  });

  it("touches nothing outside the api and storage variables", () => {
    const env = parseScaleEnv(raw, { storage: "s3" });
    const shell = devShell();
    applyStackEnv(env, scratch, loc, shell);
    expect(shell.PATH).toBe("/usr/bin");
  });
});
