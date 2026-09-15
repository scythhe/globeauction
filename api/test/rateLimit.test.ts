import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { createRateLimiter, loginRateLimiterByEmail } from "../src/middleware/rateLimit.ts";
import type { ApiError } from "../src/errors.ts";

// Pure unit tests — no DB, no HTTP server. Exercises the middleware
// function directly with fake req/res objects.

function fakeReq(overrides: Partial<Request> = {}): Request {
  return { ip: "127.0.0.1", body: {}, ...overrides } as Request;
}

async function run(
  middleware: (req: Request, res: Response, next: NextFunction) => void,
  req: Request,
): Promise<"passed" | ApiError> {
  return new Promise((resolve) => {
    const next = ((err?: unknown) => {
      resolve(err ? (err as ApiError) : "passed");
    }) as NextFunction;
    middleware(req, {} as Response, next);
  });
}

describe("createRateLimiter", () => {
  test("allows up to `max` requests within the window", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3, keyFn: () => "k" });
    for (let i = 0; i < 3; i++) {
      assert.equal(await run(limiter, fakeReq()), "passed");
    }
  });

  test("rejects the request past `max` with a 429 rate_limited error", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2, keyFn: () => "k" });
    await run(limiter, fakeReq());
    await run(limiter, fakeReq());
    const result = await run(limiter, fakeReq());
    assert.notEqual(result, "passed");
    const err = result as ApiError;
    assert.equal(err.status, 429);
    assert.equal(err.code, "rate_limited");
    assert.equal(typeof err.extra.retryAfterSeconds, "number");
  });

  test("different keys get independent buckets", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, keyFn: (req) => req.ip! });
    assert.equal(await run(limiter, fakeReq({ ip: "1.1.1.1" })), "passed");
    assert.equal(await run(limiter, fakeReq({ ip: "2.2.2.2" })), "passed");
    // second request from 1.1.1.1 should now be blocked
    assert.notEqual(await run(limiter, fakeReq({ ip: "1.1.1.1" })), "passed");
  });

  test("bucket resets after the window elapses", async () => {
    const limiter = createRateLimiter({ windowMs: 30, max: 1, keyFn: () => "k" });
    assert.equal(await run(limiter, fakeReq()), "passed");
    assert.notEqual(await run(limiter, fakeReq()), "passed");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(await run(limiter, fakeReq()), "passed", "should pass again after window resets");
  });
});

describe("loginRateLimiterByEmail — account-lockout DoS regression", () => {
  // This is the exact vulnerability found in the second pentest pass:
  // keying the login limiter on email alone let an attacker who doesn't
  // know a victim's password lock them out for 15 minutes just by sending
  // 8 garbage requests with the victim's email. Fixed by keying on
  // ip+email instead. This test exists so that fix can never silently
  // regress back to email-only keying.
  test("an attacker's failed attempts from their own IP do not lock out the victim's own login", async () => {
    const limiter = loginRateLimiterByEmail();
    const victimEmail = "victim@example.com";

    for (let i = 0; i < 8; i++) {
      const result = await run(
        limiter,
        fakeReq({ ip: "10.0.0.1", body: { email: victimEmail, password: "guess" } }),
      );
      assert.equal(result, "passed", `attacker attempt ${i + 1} should not yet be throttled`);
    }
    // attacker's own 9th attempt from their own IP: throttled.
    const attackerResult = await run(
      limiter,
      fakeReq({ ip: "10.0.0.1", body: { email: victimEmail } }),
    );
    assert.notEqual(attackerResult, "passed", "attacker should be throttled after 8 attempts");

    // the victim, connecting from a different IP, must not be affected by
    // the attacker's attempts against their email.
    const victimResult = await run(
      limiter,
      fakeReq({ ip: "203.0.113.50", body: { email: victimEmail, password: "correct-password" } }),
    );
    assert.equal(victimResult, "passed", "victim's own login from a different IP must not be blocked");
  });

  test("email matching is case-insensitive for the purposes of throttling", async () => {
    const limiter = loginRateLimiterByEmail();
    for (let i = 0; i < 8; i++) {
      await run(limiter, fakeReq({ ip: "10.0.0.1", body: { email: "Case@Example.com" } }));
    }
    const result = await run(
      limiter,
      fakeReq({ ip: "10.0.0.1", body: { email: "case@example.com" } }),
    );
    assert.notEqual(result, "passed", "different casing of the same email must share a bucket");
  });
});
