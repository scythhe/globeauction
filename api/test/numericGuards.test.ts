import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Pool } from "pg";
import * as biddingService from "../src/services/bidding.ts";
import * as adminService from "../src/services/admin.ts";
import * as vehiclesService from "../src/services/vehicles.ts";
import { ApiError } from "../src/errors.ts";
import type { Actor } from "../src/types.ts";

// Pure unit tests, no DB — regression coverage for the critical finding
// from the first pentest pass: Postgres `numeric` accepts 'NaN'/'Infinity'
// as real values and orders NaN as GREATER than every finite number
// (unlike IEEE float semantics). Without Number.isFinite() guards, a
// bidder submitting max_amount: "NaN" became permanently unbeatable —
// confirmed live, then fixed. These tests exist so that fix can't
// silently regress.
//
// A Pool that throws on any query proves these rejections happen before
// touching the database at all, not just that *some* error gets thrown.
function poisonedPool(): Pool {
  return {
    query: () => {
      throw new Error("DB should never be queried for invalid input");
    },
  } as unknown as Pool;
}

const buyer: Actor = {
  id: "11111111-1111-1111-1111-111111111111",
  role: "buyer",
  organizationId: null,
  canBid: true,
  isActive: true,
};

const team: Actor = {
  id: "22222222-2222-2222-2222-222222222222",
  role: "team",
  organizationId: null,
  canBid: false,
  isActive: true,
};

describe("bidding.placeBid — max_amount validation", () => {
  const badAmounts = [NaN, Infinity, -Infinity, 0, -500];

  for (const amount of badAmounts) {
    test(`rejects max_amount=${amount} without touching the database`, async () => {
      await assert.rejects(
        () =>
          biddingService.placeBid(
            poisonedPool(),
            buyer,
            "33333333-3333-3333-3333-333333333333",
            amount,
          ),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.status, 400);
          return true;
        },
      );
    });
  }

  test("Number('NaN') specifically — the exact payload used in the live exploit", async () => {
    // This is what the route actually does: Number(req.body.max_amount).
    // Confirms the string payload from the real exploit, run through the
    // same coercion the route applies, is rejected.
    const coerced = Number("NaN");
    await assert.rejects(() =>
      biddingService.placeBid(
        poisonedPool(),
        buyer,
        "33333333-3333-3333-3333-333333333333",
        coerced,
      ),
    );
  });

  test("still requires authentication before validating the amount", async () => {
    await assert.rejects(
      () =>
        biddingService.placeBid(poisonedPool(), null, "33333333-3333-3333-3333-333333333333", NaN),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).code, "unauthenticated");
        return true;
      },
    );
  });
});

describe("admin.recordDeposit — amount validation", () => {
  const badAmounts = [NaN, Infinity, -Infinity, -1000, 499, 0];

  for (const amount of badAmounts) {
    test(`rejects deposit amount=${amount} as below minimum, without touching the database`, async () => {
      await assert.rejects(
        () =>
          adminService.recordDeposit(
            poisonedPool(),
            team,
            "44444444-4444-4444-4444-444444444444",
            amount,
          ),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal((err as ApiError).code, "deposit_below_minimum");
          return true;
        },
      );
    });
  }

  test("rejects a non-team actor before even checking the amount", async () => {
    await assert.rejects(
      () =>
        adminService.recordDeposit(
          poisonedPool(),
          buyer,
          "44444444-4444-4444-4444-444444444444",
          500,
        ),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).code, "forbidden");
        return true;
      },
    );
  });
});

describe("vehicles.create — year/mileage validation", () => {
  const baseInput = { make: "Toyota", model: "Camry" };

  test("rejects a wildly out-of-range year without touching the database", async () => {
    await assert.rejects(
      () => vehiclesService.create(poisonedPool(), team, { ...baseInput, year: 99999 }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).status, 400);
        return true;
      },
    );
  });

  test("rejects a non-integer year", async () => {
    await assert.rejects(() =>
      vehiclesService.create(poisonedPool(), team, { ...baseInput, year: 2020.5 }),
    );
  });

  test("rejects negative mileage", async () => {
    await assert.rejects(() =>
      vehiclesService.create(poisonedPool(), team, { ...baseInput, year: 2020, mileage: -500 }),
    );
  });

  test("rejects non-finite mileage", async () => {
    await assert.rejects(() =>
      vehiclesService.create(poisonedPool(), team, {
        ...baseInput,
        year: 2020,
        mileage: Infinity,
      }),
    );
  });

  test("rejects a non-team actor before validating anything else", async () => {
    await assert.rejects(
      () => vehiclesService.create(poisonedPool(), buyer, { ...baseInput, year: 2020 }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).code, "forbidden");
        return true;
      },
    );
  });
});
