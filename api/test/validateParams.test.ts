import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { requireUuidParams, uuidParam } from "../src/middleware/validateParams.ts";
import { ApiError } from "../src/errors.ts";

// Pure unit tests — regression coverage for the "malformed id crashes with
// 500 instead of 400" class of bug found across two pentest rounds
// (`/vehicles/' OR '1'='1` and friends).

function fakeReq(params: Record<string, string>): Request {
  return { params } as unknown as Request;
}

function run(
  middleware: (req: Request, res: Response, next: NextFunction) => void,
  req: Request,
): "passed" | ApiError {
  let result: "passed" | ApiError = "passed";
  const next = ((err?: unknown) => {
    result = err ? (err as ApiError) : "passed";
  }) as NextFunction;
  middleware(req, {} as Response, next);
  return result;
}

describe("requireUuidParams", () => {
  test("passes a well-formed UUID", () => {
    const mw = requireUuidParams("id");
    const result = run(mw, fakeReq({ id: "550e8400-e29b-41d4-a716-446655440000" }));
    assert.equal(result, "passed");
  });

  test("rejects a SQL-injection-shaped string with a clean 400, not a DB crash", () => {
    const mw = requireUuidParams("id");
    const result = run(mw, fakeReq({ id: "' OR '1'='1" }));
    assert.notEqual(result, "passed");
    assert.equal((result as ApiError).status, 400);
    assert.equal((result as ApiError).code, "validation_error");
  });

  test("rejects a missing param", () => {
    const mw = requireUuidParams("id");
    const result = run(mw, fakeReq({}));
    assert.notEqual(result, "passed");
  });

  test("rejects an empty string", () => {
    const mw = requireUuidParams("id");
    const result = run(mw, fakeReq({ id: "" }));
    assert.notEqual(result, "passed");
  });

  test("validates every listed param, not just the first", () => {
    const mw = requireUuidParams("id", "otherId");
    const result = run(
      mw,
      fakeReq({ id: "550e8400-e29b-41d4-a716-446655440000", otherId: "not-a-uuid" }),
    );
    assert.notEqual(result, "passed");
  });
});

describe("uuidParam", () => {
  test("returns the value when it's a valid UUID", () => {
    const req = fakeReq({ id: "550e8400-e29b-41d4-a716-446655440000" });
    assert.equal(uuidParam(req, "id"), "550e8400-e29b-41d4-a716-446655440000");
  });

  test("throws a validation ApiError when missing (defense in depth if the guard middleware is skipped)", () => {
    const req = fakeReq({});
    assert.throws(() => uuidParam(req, "id"), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 400);
      return true;
    });
  });

  test("throws on a present-but-malformed value too — must not rely on requireUuidParams having run first", () => {
    // This is deliberately independent of the middleware: uuidParam is
    // meant to be safe to call on its own. Writing this test caught a real
    // gap — uuidParam originally only checked `typeof value === "string"`,
    // not the UUID shape, so a route calling it without the middleware
    // guard would have let a SQL-injection-shaped string straight through.
    const req = fakeReq({ id: "' OR '1'='1" });
    assert.throws(() => uuidParam(req, "id"));
  });
});
