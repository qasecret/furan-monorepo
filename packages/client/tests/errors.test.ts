import { describe, expect, it } from "vitest";

import {
  FuranApiError,
  FuranConfigError,
  FuranError,
  FuranInputError,
  FuranTimeoutError,
} from "../src/index.js";

describe("errors", () => {
  it("FuranApiError says the method, path, status, code and server message", () => {
    const err = new FuranApiError({
      status: 403,
      code: "not_a_project_member",
      message: "Not a project member",
      method: "POST",
      path: "runs",
      requestId: "req-1",
    });
    expect(err.message).toBe(
      "POST /runs → 403 not_a_project_member: Not a project member",
    );
    expect(err).toBeInstanceOf(FuranError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("not_a_project_member");
    expect(err.requestId).toBe("req-1");
  });

  it("every error is a FuranError with its own name", () => {
    const errors = [
      new FuranConfigError("FURAN_API_TOKEN", "FURAN_API_TOKEN is required"),
      new FuranInputError("not a PNG", "a.png"),
      new FuranTimeoutError("run-1", "running", 120_000),
    ];
    for (const e of errors) expect(e).toBeInstanceOf(FuranError);
    expect(errors.map((e) => e.name)).toEqual([
      "FuranConfigError",
      "FuranInputError",
      "FuranTimeoutError",
    ]);
    expect((errors[0] as FuranConfigError).variable).toBe("FURAN_API_TOKEN");
    expect((errors[1] as FuranInputError).file).toBe("a.png");
    expect(errors[2]!.message).toMatch(/run-1.*120s.*running/);
  });
});
