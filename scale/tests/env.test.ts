import { describe, expect, it } from "vitest";

import { ScaleEnvError, parseScaleEnv, scratchUrl } from "../src/env.js";

const base = {
  SCALE_DATABASE_URL: "postgres://admin:secret@127.0.0.1:5432/postgres",
  SCALE_REDIS_URL: "redis://127.0.0.1:6379",
  SCALE_S3_ENDPOINT: "http://127.0.0.1:9100",
  SCALE_S3_ACCESS_KEY: "ak",
  SCALE_S3_SECRET_KEY: "sk",
};

describe("parseScaleEnv", () => {
  it("parses a complete s3 environment", () => {
    const env = parseScaleEnv(base, { storage: "s3" });
    expect(env.storage).toBe("s3");
    expect(env.databaseUrl).toBe(base.SCALE_DATABASE_URL);
    expect(env.redisUrl).toBe(base.SCALE_REDIS_URL);
    expect(env.databaseUrlApp).toBeUndefined();
    expect(env.s3).toEqual({
      endpoint: base.SCALE_S3_ENDPOINT,
      accessKey: "ak",
      secretKey: "sk",
      region: "us-east-1",
    });
  });

  it("takes the optional region and app-role URL when present", () => {
    const env = parseScaleEnv(
      {
        ...base,
        SCALE_S3_REGION: "eu-west-1",
        SCALE_DATABASE_URL_APP:
          "postgres://app:pw@127.0.0.1:5432/postgres?sslmode=disable",
      },
      { storage: "s3" },
    );
    expect(env.s3?.region).toBe("eu-west-1");
    expect(env.databaseUrlApp).toBe(
      "postgres://app:pw@127.0.0.1:5432/postgres?sslmode=disable",
    );
  });

  it("refuses a missing SCALE_DATABASE_URL", () => {
    const { SCALE_DATABASE_URL: _omit, ...rest } = base;
    expect(() => parseScaleEnv(rest, { storage: "s3" })).toThrow(ScaleEnvError);
    expect(() => parseScaleEnv(rest, { storage: "s3" })).toThrow(
      /SCALE_DATABASE_URL/,
    );
  });

  it("refuses a missing SCALE_REDIS_URL and each missing s3 variable", () => {
    for (const name of [
      "SCALE_REDIS_URL",
      "SCALE_S3_ENDPOINT",
      "SCALE_S3_ACCESS_KEY",
      "SCALE_S3_SECRET_KEY",
    ] as const) {
      const raw: NodeJS.ProcessEnv = { ...base };
      delete raw[name];
      expect(() => parseScaleEnv(raw, { storage: "s3" })).toThrow(
        new RegExp(name),
      );
    }
  });

  it("treats an empty value as missing", () => {
    expect(() =>
      parseScaleEnv({ ...base, SCALE_REDIS_URL: "  " }, { storage: "s3" }),
    ).toThrow(/SCALE_REDIS_URL/);
  });

  it("refuses a URL whose database is furan_scale", () => {
    expect(() =>
      parseScaleEnv(
        {
          ...base,
          SCALE_DATABASE_URL:
            "postgres://admin:secret@127.0.0.1:5432/furan_scale",
        },
        { storage: "s3" },
      ),
    ).toThrow(/furan_scale/);
  });

  it("ignores DATABASE_URL, REDIS_URL and S3_*", () => {
    const dev = {
      DATABASE_URL: "postgres://dev:dev@localhost:5433/furan",
      REDIS_URL: "redis://localhost:6380",
      S3_ENDPOINT: "http://localhost:9000",
      S3_ACCESS_KEY: "dev",
      S3_SECRET_KEY: "dev",
    };
    expect(() => parseScaleEnv(dev, { storage: "s3" })).toThrow(
      /SCALE_DATABASE_URL/,
    );
    expect(() =>
      parseScaleEnv(
        {
          ...dev,
          SCALE_DATABASE_URL: base.SCALE_DATABASE_URL,
          SCALE_REDIS_URL: base.SCALE_REDIS_URL,
        },
        { storage: "s3" },
      ),
    ).toThrow(/SCALE_S3_ENDPOINT/);

    const env = parseScaleEnv({ ...dev, ...base }, { storage: "s3" });
    expect(env.databaseUrl).toBe(base.SCALE_DATABASE_URL);
    expect(env.redisUrl).toBe(base.SCALE_REDIS_URL);
    expect(env.s3?.endpoint).toBe(base.SCALE_S3_ENDPOINT);
  });

  it("hdd needs no S3 vars", () => {
    const env = parseScaleEnv(
      {
        SCALE_DATABASE_URL: base.SCALE_DATABASE_URL,
        SCALE_REDIS_URL: base.SCALE_REDIS_URL,
      },
      { storage: "hdd" },
    );
    expect(env.storage).toBe("hdd");
    expect(env.s3).toBeUndefined();
  });

  it("does not echo the connection string (it carries a password) on a malformed URL", () => {
    let message = "";
    try {
      parseScaleEnv(
        { ...base, SCALE_DATABASE_URL: "not a url, hunter2" },
        { storage: "s3" },
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/SCALE_DATABASE_URL/);
    expect(message).not.toMatch(/hunter2/);
  });

  it("refuses URLs of the wrong kind", () => {
    expect(() =>
      parseScaleEnv(
        { ...base, SCALE_DATABASE_URL: "mysql://u:p@127.0.0.1/db" },
        { storage: "s3" },
      ),
    ).toThrow(/SCALE_DATABASE_URL/);
    expect(() =>
      parseScaleEnv(
        { ...base, SCALE_REDIS_URL: "http://127.0.0.1:6379" },
        { storage: "s3" },
      ),
    ).toThrow(/SCALE_REDIS_URL/);
  });
});

describe("scratchUrl", () => {
  it("replaces only the database", () => {
    const url =
      "postgres://us%40er:p%40ss%2Fword@db.internal:5433/postgres?sslmode=require&application_name=scale";
    expect(scratchUrl(url)).toBe(
      "postgres://us%40er:p%40ss%2Fword@db.internal:5433/furan_scale?sslmode=require&application_name=scale",
    );
  });

  it("takes an explicit database name", () => {
    expect(scratchUrl("postgres://u:p@h:5432/postgres", "other_db")).toBe(
      "postgres://u:p@h:5432/other_db",
    );
  });

  it("adds a database when the URL has none", () => {
    expect(scratchUrl("postgres://u:p@h:5432")).toBe(
      "postgres://u:p@h:5432/furan_scale",
    );
  });
});
