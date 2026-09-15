import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Client, Pool } from "pg";
import * as adminService from "../src/services/admin.ts";
import { ApiError } from "../src/errors.ts";
import { connect, createUser, reset, testPool } from "./helpers.ts";
import type { Actor } from "../src/types.ts";

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

function actorFor(id: string, role: "team" | "buyer" | "dealer" = "team"): Actor {
  return { id, role, organizationId: null, canBid: false, isActive: true };
}

describe("admin.recordDeposit + enableBidding — the two-step deposit gate (§2.1)", () => {
  test("the full happy path: record 500, then enable bidding", async () => {
    const team = await createUser(client, { role: "team" });
    const buyer = await createUser(client, { role: "buyer", canBid: false });
    const teamActor = actorFor(team.id);

    const afterDeposit = await adminService.recordDeposit(pool, teamActor, buyer.id, 500);
    assert.equal(afterDeposit.depositAmount, "500.00");
    assert.equal(afterDeposit.canBid, false, "recording a deposit alone must not enable bidding");

    const afterEnable = await adminService.enableBidding(pool, teamActor, buyer.id);
    assert.equal(afterEnable!.canBid, true);
    assert.equal(afterEnable!.bidEnabledBy, team.id);
  });

  test("cannot enable bidding before any deposit is recorded", async () => {
    const team = await createUser(client, { role: "team" });
    const buyer = await createUser(client, { role: "buyer" });
    await assert.rejects(
      () => adminService.enableBidding(pool, actorFor(team.id), buyer.id),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).code, "deposit_required");
        return true;
      },
    );
  });

  test("rejects a deposit under 500 GEL", async () => {
    const team = await createUser(client, { role: "team" });
    const buyer = await createUser(client, { role: "buyer" });
    await assert.rejects(
      () => adminService.recordDeposit(pool, actorFor(team.id), buyer.id, 499),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).code, "deposit_below_minimum");
        return true;
      },
    );
  });

  // Defense-in-depth regression: recordDeposit's own Number.isFinite guard
  // stops a NaN deposit from ever being written now — but this test proves
  // enableBidding's *second*, independent check also catches it, in case a
  // NaN deposit_amount ever ends up in the DB some other way (a future
  // migration, a manual fix, a bug in a different write path). Confirmed
  // live pre-fix: a deposit_amount of the literal string 'NaN' passed both
  // `< 500` checks, since NaN comparisons are always false in JS.
  test("enableBidding independently rejects a NaN deposit_amount already in the DB", async () => {
    const team = await createUser(client, { role: "team" });
    const buyer = await createUser(client, { role: "buyer" });
    await client.query(
      "update users set deposit_amount = 'NaN', deposit_received_at = now() where id = $1",
      [buyer.id],
    );
    await assert.rejects(
      () => adminService.enableBidding(pool, actorFor(team.id), buyer.id),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).code, "deposit_below_minimum");
        return true;
      },
    );
  });

  test("buyer/dealer roles cannot record deposits or enable bidding for anyone, including themselves", async () => {
    const buyer = await createUser(client, { role: "buyer" });
    await assert.rejects(
      () => adminService.recordDeposit(pool, actorFor(buyer.id, "buyer"), buyer.id, 500),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "forbidden");
        return true;
      },
    );
    await assert.rejects(
      () => adminService.enableBidding(pool, actorFor(buyer.id, "buyer"), buyer.id),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "forbidden");
        return true;
      },
    );
  });

  test("unauthenticated calls are rejected before any role check", async () => {
    const buyer = await createUser(client, { role: "buyer" });
    await assert.rejects(
      () => adminService.recordDeposit(pool, null, buyer.id, 500),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "unauthenticated");
        return true;
      },
    );
  });
});

describe("admin.listUnvetted", () => {
  test("only lists users who don't yet have can_bid, and excludes team", async () => {
    const team = await createUser(client, { role: "team" });
    const vetted = await createUser(client, { role: "buyer", canBid: true });
    const unvetted = await createUser(client, { role: "buyer", canBid: false });

    const list = await adminService.listUnvetted(pool, actorFor(team.id));
    const ids = list.map((u) => u.id);
    assert.ok(ids.includes(unvetted.id));
    assert.ok(!ids.includes(vetted.id));
    assert.ok(!ids.includes(team.id));
  });

  test("never includes password_hash in the response — confirmed leaking in a prior pentest pass", async () => {
    const team = await createUser(client, { role: "team" });
    await createUser(client, { role: "buyer", canBid: false });
    const list = await adminService.listUnvetted(pool, actorFor(team.id));
    for (const user of list) {
      assert.ok(!("password_hash" in user));
    }
  });
});
