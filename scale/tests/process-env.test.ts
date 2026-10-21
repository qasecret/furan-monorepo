import { describe, expect, it } from "vitest";

import { parseScaleEnv } from "../src/env.js";
import { stackEnv } from "../src/stack/process-env.js";

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
