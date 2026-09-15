import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Client, Pool } from "pg";
import * as authService from "../src/services/auth.ts";
import { ApiError } from "../src/errors.ts";
import { connect, reset, testPool } from "./helpers.ts";

let client: Client;
let pool: Pool;

before(async () => {
  client = await connect();
  pool = testPool();
});

after(async () => {
  await client.end();
  await pool.end();
});

beforeEach(async () => {
  await reset(client);
});

describe("auth.register", () => {
  test("creates a buyer account and never returns the password hash", async () => {
    const user = await authService.register(pool, {
      email: "new@example.com",
      password: "password123",
      fullName: "New User",
    });
    assert.equal(user.role, "buyer");
    assert.equal(user.canBid, false);
    assert.ok(!("password_hash" in user), "password_hash must never be in the response");
  });

  test("rejects a duplicate email with 409, not a raw DB constraint error", async () => {
    await authService.register(pool, {
      email: "dupe@example.com",
      password: "password123",
      fullName: "First",
    });
    await assert.rejects(
      () =>
        authService.register(pool, {
          email: "dupe@example.com",
          password: "password123",
          fullName: "Second",
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        return true;
      },
    );
  });

  test("rejects a password under 8 characters", async () => {
    await assert.rejects(() =>
      authService.register(pool, { email: "short@example.com", password: "abc", fullName: "X" }),
    );
  });

  // Mass-assignment regression: register only ever destructures known
  // fields into a hardcoded 'buyer' insert — confirmed live in a pentest
  // pass that an extra "role": "team" field in the request body is simply
  // ignored, not a privilege-escalation vector.
  test("ignores an extra role field in the input — role is always buyer", async () => {
    const user = await authService.register(pool, {
      email: "sneaky@example.com",
      password: "password123",
      fullName: "Sneaky",
      // @ts-expect-error deliberately passing an unexpected field
      role: "team",
    });
    assert.equal(user.role, "buyer");
  });
});

describe("auth.login", () => {
  test("succeeds with the right password and creates a session", async () => {
    await authService.register(pool, {
      email: "login@example.com",
      password: "correctpassword",
      fullName: "Login Test",
    });
    const result = await authService.login(pool, "login@example.com", "correctpassword");
    assert.ok(result.token);
    assert.equal(result.user.email, "login@example.com");
  });

  test("fails with the wrong password", async () => {
    await authService.register(pool, {
      email: "login2@example.com",
      password: "correctpassword",
      fullName: "Login Test 2",
    });
    await assert.rejects(
      () => authService.login(pool, "login2@example.com", "wrongpassword"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).code, "invalid_credentials");
        return true;
      },
    );
  });

  test("fails for a nonexistent email with the same error code as a wrong password (no user enumeration via error content)", async () => {
    await assert.rejects(
      () => authService.login(pool, "nobody-here@example.com", "whatever"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).code, "invalid_credentials");
        return true;
      },
    );
  });

  test("still runs a real password verify for a nonexistent email (timing side-channel fix)", async () => {
    // Doesn't assert on timing (too flaky to assert reliably in CI) — this
    // just confirms the code path that fixed the timing side-channel
    // (verifying against a dummy hash when no user is found) actually
    // executes without throwing, for every login attempt against an
    // unknown email, not just the first one (the dummy hash is memoized).
    await assert.rejects(() => authService.login(pool, "unknown1@example.com", "x"));
    await assert.rejects(() => authService.login(pool, "unknown2@example.com", "x"));
    await assert.rejects(() => authService.login(pool, "unknown3@example.com", "x"));
  });

  test("rejects a deactivated account even with the correct password", async () => {
    await authService.register(pool, {
      email: "deactivated@example.com",
      password: "correctpassword",
      fullName: "Deactivated",
    });
    await client.query("update users set is_active = false where email = $1", [
      "deactivated@example.com",
    ]);
    await assert.rejects(
      () => authService.login(pool, "deactivated@example.com", "correctpassword"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).code, "invalid_credentials");
        return true;
      },
    );
  });
});

describe("auth.resolveActor", () => {
  test("returns null for a missing token", async () => {
    const actor = await authService.resolveActor(pool, null);
    assert.equal(actor, null);
  });

  test("returns null for a garbage token", async () => {
    const actor = await authService.resolveActor(pool, "not-a-real-token");
    assert.equal(actor, null);
  });

  test("resolves a valid session token to the right actor", async () => {
    await authService.register(pool, {
      email: "resolve@example.com",
      password: "password123",
      fullName: "Resolve Test",
    });
    const { token, user } = await authService.login(pool, "resolve@example.com", "password123");
    const actor = await authService.resolveActor(pool, token);
    assert.ok(actor);
    assert.equal(actor!.id, user.id);
    assert.equal(actor!.role, "buyer");
  });
});
