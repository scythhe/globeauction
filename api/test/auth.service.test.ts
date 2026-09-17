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

  // A non-string password's `.length` is `undefined`, and `undefined < 8`
  // is `false` — the length check silently passed and the bad value hit
  // hashPassword(), crashing as an uncaught 500 instead of a clean 400.
  test("rejects a non-string password with a clean 400, not a crash", async () => {
    await assert.rejects(
      () =>
        authService.register(pool, {
          email: "typeconfuse1@example.com",
          // @ts-expect-error deliberately wrong type — this is what req.body can hold
          password: 12345678,
          fullName: "X",
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 400);
        return true;
      },
    );
  });

  test("rejects a non-string email with a clean 400", async () => {
    await assert.rejects(
      () =>
        authService.register(pool, {
          // @ts-expect-error deliberately wrong type
          email: 12345,
          password: "password123",
          fullName: "X",
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 400);
        return true;
      },
    );
  });

  test("rejects a non-string fullName with a clean 400", async () => {
    await assert.rejects(
      () =>
        authService.register(pool, {
          email: "typeconfuse3@example.com",
          password: "password123",
          // @ts-expect-error deliberately wrong type
          fullName: { first: "X" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 400);
        return true;
      },
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

  test("rejects a non-string password the same way as a wrong one (no distinguishable error)", async () => {
    await authService.register(pool, {
      email: "typeconfuse-login@example.com",
      password: "correctpassword",
      fullName: "Type Confuse",
    });
    await assert.rejects(
      // @ts-expect-error deliberately wrong type — this is what req.body can hold
      () => authService.login(pool, "typeconfuse-login@example.com", 12345678),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).code, "invalid_credentials");
        return true;
      },
    );
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

// `revoked_at` existed on the schema and was checked on every session
// lookup, but nothing ever set it — logging out only ever discarded the
// token client-side, so a leaked token stayed valid until its natural
// expiry regardless. Sessions are DB-backed specifically for instant
// revocability; this is what actually delivers that.
describe("auth.logout", () => {
  test("revokes the session — the same token no longer resolves to an actor", async () => {
    await authService.register(pool, {
      email: "logout1@example.com",
      password: "correctpassword",
      fullName: "Logout Test",
    });
    const { token } = await authService.login(pool, "logout1@example.com", "correctpassword");

    const beforeLogout = await authService.resolveActor(pool, token);
    assert.ok(beforeLogout, "token must be valid before logout");

    await authService.logout(pool, token);

    const afterLogout = await authService.resolveActor(pool, token);
    assert.equal(afterLogout, null, "token must be rejected immediately after logout");
  });

  test("does not affect a different session for the same user", async () => {
    await authService.register(pool, {
      email: "logout2@example.com",
      password: "correctpassword",
      fullName: "Logout Test 2",
    });
    const sessionA = await authService.login(pool, "logout2@example.com", "correctpassword");
    const sessionB = await authService.login(pool, "logout2@example.com", "correctpassword");

    await authService.logout(pool, sessionA.token);

    assert.equal(await authService.resolveActor(pool, sessionA.token), null);
    assert.ok(await authService.resolveActor(pool, sessionB.token), "session B must be untouched");
  });

  test("is idempotent — logging out twice does not throw", async () => {
    await authService.register(pool, {
      email: "logout3@example.com",
      password: "correctpassword",
      fullName: "Logout Test 3",
    });
    const { token } = await authService.login(pool, "logout3@example.com", "correctpassword");

    await authService.logout(pool, token);
    await authService.logout(pool, token); // must not throw
  });

  test("a null/missing token is a silent no-op", async () => {
    await authService.logout(pool, null); // must not throw
  });

  test("an unrecognized token is a silent no-op, not an error (no info leak about token validity)", async () => {
    await authService.logout(pool, "this-token-was-never-issued"); // must not throw
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
