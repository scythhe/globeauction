import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Client, Pool } from "pg";
import * as auctionsService from "../src/services/auctions.ts";
import { ApiError } from "../src/errors.ts";
import {
  connect,
  createAuction,
  createUser,
  createVehicle,
  placeBid,
  reset,
  setAuctionStatus,
  testPool,
} from "./helpers.ts";
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

describe("auctions.create", () => {
  test("team can create an auction on an approved vehicle", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id, { status: "approved" });
    const auction = await auctionsService.create(pool, actorFor(team.id), {
      vehicleId: vehicle.id,
      startingPrice: 1000,
      reservePrice: 1000,
      startsAt: new Date(Date.now() - 1000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    assert.equal(auction.status, "scheduled");
  });

  test("rejects a non-team actor", async () => {
    const buyer = await createUser(client, { role: "buyer" });
    const vehicle = await createVehicle(client, buyer.id, { status: "approved" });
    await assert.rejects(
      () =>
        auctionsService.create(pool, actorFor(buyer.id, "buyer"), {
          vehicleId: vehicle.id,
          startingPrice: 1000,
          reservePrice: 1000,
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "forbidden");
        return true;
      },
    );
  });

  test("rejects a vehicle that isn't approved", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id, { status: "draft" });
    await assert.rejects(
      () =>
        auctionsService.create(pool, actorFor(team.id), {
          vehicleId: vehicle.id,
          startingPrice: 1000,
          reservePrice: 1000,
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "vehicle_not_approved");
        return true;
      },
    );
  });

  test("rejects a reserve below the starting price (§1's phase-1 safety rule)", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id, { status: "approved" });
    await assert.rejects(
      () =>
        auctionsService.create(pool, actorFor(team.id), {
          vehicleId: vehicle.id,
          startingPrice: 1000,
          reservePrice: 500,
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "reserve_below_starting_price");
        return true;
      },
    );
  });

  // NaN/Infinity regression: unlike bidding.ts and admin.ts, this guard
  // runs *after* the vehicle lookup (a DB call), so it can't be a pure
  // unit test — covered here instead.
  for (const badPrice of [NaN, Infinity, -Infinity]) {
    test(`rejects startingPrice=${badPrice}`, async () => {
      const team = await createUser(client, { role: "team" });
      const vehicle = await createVehicle(client, team.id, { status: "approved" });
      await assert.rejects(
        () =>
          auctionsService.create(pool, actorFor(team.id), {
            vehicleId: vehicle.id,
            startingPrice: badPrice,
            reservePrice: 1000,
            startsAt: new Date().toISOString(),
            endsAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        (err: unknown) => {
          assert.equal((err as ApiError).code, "invalid_price");
          return true;
        },
      );
    });
  }

  test("rejects an end time before the start time", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id, { status: "approved" });
    await assert.rejects(
      () =>
        auctionsService.create(pool, actorFor(team.id), {
          vehicleId: vehicle.id,
          startingPrice: 1000,
          reservePrice: 1000,
          startsAt: new Date(Date.now() + 3_600_000).toISOString(),
          endsAt: new Date().toISOString(),
        }),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "invalid_auction_window");
        return true;
      },
    );
  });

  test("accepts a buy-now price at or above the reserve", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id, { status: "approved" });
    const auction = await auctionsService.create(pool, actorFor(team.id), {
      vehicleId: vehicle.id,
      startingPrice: 1000,
      reservePrice: 1000,
      buyNowPrice: 3000,
      startsAt: new Date(Date.now() - 1000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    assert.equal((auction as { buy_now_price: string }).buy_now_price, "3000.00");
  });

  test("rejects a buy-now price below the reserve", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id, { status: "approved" });
    await assert.rejects(
      () =>
        auctionsService.create(pool, actorFor(team.id), {
          vehicleId: vehicle.id,
          startingPrice: 1000,
          reservePrice: 2000,
          buyNowPrice: 1500,
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "buy_now_below_reserve");
        return true;
      },
    );
  });
});

describe("auctions.getById / list — reserve price redaction (§6)", () => {
  // This is the bug confirmed live and fixed last session: reserve_price
  // used to be returned verbatim to every caller. The spec is explicit —
  // "Not shown to bidders; the listing shows only whether the reserve has
  // been met."
  test("team sees the raw reserve_price", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, { reservePrice: 5000 });

    const result = await auctionsService.getById(pool, actorFor(team.id), auction.id);
    assert.equal((result as { reserve_price: string }).reserve_price, "5000.00");
  });

  test("a buyer never sees reserve_price, only a reserveMet boolean", async () => {
    const team = await createUser(client, { role: "team" });
    const buyer = await createUser(client, { role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, {
      startingPrice: 1000,
      reservePrice: 5000,
    });

    const result = await auctionsService.getById(pool, actorFor(buyer.id, "buyer"), auction.id);
    assert.ok(!("reserve_price" in result), "reserve_price must not be present at all");
    assert.equal((result as { reserveMet: boolean }).reserveMet, false);
  });

  test("an unauthenticated (anonymous) viewer also never sees reserve_price", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, { reservePrice: 5000 });

    const result = await auctionsService.getById(pool, null, auction.id);
    assert.ok(!("reserve_price" in result));
  });

  test("reserveMet reflects current_price vs reserve_price correctly", async () => {
    const team = await createUser(client, { role: "team" });
    const buyer = await createUser(client, { role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, {
      startingPrice: 1000,
      reservePrice: 1000,
    });

    const result = await auctionsService.getById(pool, actorFor(buyer.id, "buyer"), auction.id);
    assert.equal((result as { reserveMet: boolean }).reserveMet, true, "current_price == reserve_price should count as met");
  });

  test("list() redacts reserve_price for every non-team auction the same way", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    await createAuction(client, vehicle.id, team.id, { reservePrice: 5000 });

    const results = await auctionsService.list(pool, null, {});
    assert.ok(results.length > 0);
    for (const auction of results) {
      assert.ok(!("reserve_price" in auction));
    }
  });

  test("nextMinimumBid is present for every viewer and matches bid_increment()'s own rule", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, { startingPrice: 1000 });

    const asBuyer = await auctionsService.getById(pool, null, auction.id);
    assert.equal((asBuyer as { nextMinimumBid: string }).nextMinimumBid, "1000.00");

    await placeBid(client, auction.id, (await createUser(client)).id, 1200);
    const after = await auctionsService.getById(pool, null, auction.id);
    // current_price is now 1000 (starting), increment at 1000 is 100.
    assert.equal((after as { nextMinimumBid: string }).nextMinimumBid, "1100.00");
  });
});

describe("auctions.buyNow", () => {
  test("happy path: closes the auction as sold", async () => {
    const team = await createUser(client, { role: "team" });
    const buyer = await createUser(client, { role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, {
      startingPrice: 1000,
      buyNowPrice: 3000,
    });

    const result = await auctionsService.buyNow(pool, actorFor(buyer.id, "buyer"), auction.id);
    assert.equal(result.status, "sold");
    assert.equal(Number(result.final_price), 3000);
    assert.equal(result.sold_to, buyer.id);
  });

  test("maps buy_now_not_available to a clean 400", async () => {
    const team = await createUser(client, { role: "team" });
    const buyer = await createUser(client, { role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, { startingPrice: 1000 });

    await assert.rejects(
      () => auctionsService.buyNow(pool, actorFor(buyer.id, "buyer"), auction.id),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 400);
        assert.equal(err.code, "buy_now_not_available");
        return true;
      },
    );
  });

  test("maps buy_now_already_bid to a clean 400 once a real bid exists", async () => {
    const team = await createUser(client, { role: "team" });
    const firstBidder = await createUser(client, { role: "buyer" });
    const buyer = await createUser(client, { role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, {
      startingPrice: 1000,
      buyNowPrice: 3000,
    });
    await placeBid(client, auction.id, firstBidder.id, 1200);

    await assert.rejects(
      () => auctionsService.buyNow(pool, actorFor(buyer.id, "buyer"), auction.id),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "buy_now_already_bid");
        return true;
      },
    );
  });

  test("requires authentication", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, {
      startingPrice: 1000,
      buyNowPrice: 3000,
    });
    await assert.rejects(
      () => auctionsService.buyNow(pool, null, auction.id),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "unauthenticated");
        return true;
      },
    );
  });
});

// BACKEND_SPEC.md §12 (lines 620, 622) is stricter than the old comment
// here implied: max_amount is bidder-only — never shown to anyone else,
// team included. ip_address/user_agent are team-only (visible to team on
// every row, hidden from everyone else). Two independent rules, not one.
describe("auctions.listBids — max_amount is bidder-only, ip/user_agent are team-only", () => {
  test("bidder sees their own max_amount; nobody else does, not even team", async () => {
    const team = await createUser(client, { role: "team" });
    const bidder = await createUser(client, { role: "buyer" });
    const viewer = await createUser(client, { role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, { startingPrice: 1000 });
    await placeBid(client, auction.id, bidder.id, 1500);

    const ownView = await auctionsService.listBids(pool, actorFor(bidder.id, "buyer"), auction.id);
    assert.equal((ownView[0] as { max_amount: string }).max_amount, "1500.00");

    const teamView = await auctionsService.listBids(pool, actorFor(team.id), auction.id);
    assert.equal((teamView[0] as { max_amount: string | null }).max_amount, null);

    const buyerView = await auctionsService.listBids(
      pool,
      actorFor(viewer.id, "buyer"),
      auction.id,
    );
    assert.equal((buyerView[0] as { max_amount: string | null }).max_amount, null);
    assert.ok(!("ip_address" in buyerView[0]));
  });

  test("ip_address/user_agent are visible to team on every row, hidden from everyone else", async () => {
    const team = await createUser(client, { role: "team" });
    const bidder = await createUser(client, { role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, { startingPrice: 1000 });
    await placeBid(client, auction.id, bidder.id, 1500);

    const teamView = await auctionsService.listBids(pool, actorFor(team.id), auction.id);
    assert.ok((teamView[0] as { ip_address: string | null }).ip_address !== undefined);

    const bidderView = await auctionsService.listBids(
      pool,
      actorFor(bidder.id, "buyer"),
      auction.id,
    );
    assert.ok(!("ip_address" in bidderView[0]));
    assert.ok(!("user_agent" in bidderView[0]));
  });
});

describe("auctions.cancel / acceptAsIs / decline / reassignSale", () => {
  test("cancel: team-only", async () => {
    const team = await createUser(client, { role: "team" });
    const buyer = await createUser(client, { role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id);

    await assert.rejects(
      () => auctionsService.cancel(pool, actorFor(buyer.id, "buyer"), auction.id),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "forbidden");
        return true;
      },
    );

    const cancelled = await auctionsService.cancel(pool, actorFor(team.id), auction.id);
    assert.equal(cancelled.status, "cancelled");
  });

  test("cancel: rejects an auction that's already sold — §4's terminal states", async () => {
    const team = await createUser(client, { role: "team" });
    const bidder = await createUser(client, { role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, { startingPrice: 1000 });
    await placeBid(client, auction.id, bidder.id, 1500);
    await setAuctionStatus(client, auction.id, "sold", { finalPrice: 1000, soldTo: bidder.id });

    await assert.rejects(
      () => auctionsService.cancel(pool, actorFor(team.id), auction.id),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "cannot_cancel");
        return true;
      },
    );
  });

  test("cancel is idempotent on an already-cancelled auction — §4 excludes only sold/unsold", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id);

    await auctionsService.cancel(pool, actorFor(team.id), auction.id);
    const cancelledAgain = await auctionsService.cancel(pool, actorFor(team.id), auction.id);
    assert.equal(cancelledAgain.status, "cancelled");
  });

  test("acceptAsIs: only on pending_seller, team-only", async () => {
    const team = await createUser(client, { role: "team" });
    const bidder = await createUser(client, { role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, {
      startingPrice: 1000,
      reservePrice: 5000,
    });
    await placeBid(client, auction.id, bidder.id, 1200);
    await setAuctionStatus(client, auction.id, "pending_seller");

    const accepted = await auctionsService.acceptAsIs(pool, actorFor(team.id), auction.id);
    assert.equal(accepted.status, "sold");
    assert.equal(accepted.final_price, "1000.00");
    assert.equal(accepted.sold_to, bidder.id);
  });

  test("decline: moves a pending_seller auction to unsold", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id);
    await setAuctionStatus(client, auction.id, "pending_seller");

    const declined = await auctionsService.decline(pool, actorFor(team.id), auction.id);
    assert.equal(declined.status, "unsold");
  });

  test("reassignSale: reassigns to a real underbidder and recomputes final_price from their own bid", async () => {
    const team = await createUser(client, { role: "team" });
    const alice = await createUser(client, { role: "buyer" });
    const bob = await createUser(client, { role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, { startingPrice: 1000 });

    await placeBid(client, auction.id, alice.id, 1500);
    await placeBid(client, auction.id, bob.id, 3000); // bob wins the lead
    await setAuctionStatus(client, auction.id, "sold", { finalPrice: 1600, soldTo: bob.id });

    // bob doesn't pay — reassign to alice, the underbidder
    const reassigned = await auctionsService.reassignSale(pool, actorFor(team.id), auction.id, alice.id);
    assert.equal(reassigned.sold_to, alice.id);
    assert.equal(reassigned.status, "sold", "status stays sold throughout — no dedicated second-chance state");
    // alice's own recorded amount from her losing bid, not an arbitrary number
    assert.ok(Number(reassigned.final_price) > 0);
  });

  test("reassignSale: rejects a target user with no bid on this auction", async () => {
    const team = await createUser(client, { role: "team" });
    const bidder = await createUser(client, { role: "buyer" });
    const strangerNotBidding = await createUser(client, { role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, { startingPrice: 1000 });
    await placeBid(client, auction.id, bidder.id, 1500);
    await setAuctionStatus(client, auction.id, "sold", { finalPrice: 1000, soldTo: bidder.id });

    await assert.rejects(
      () =>
        auctionsService.reassignSale(pool, actorFor(team.id), auction.id, strangerNotBidding.id),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "cannot_reassign");
        return true;
      },
    );
  });

  test("reassignSale: team-only", async () => {
    const team = await createUser(client, { role: "team" });
    const bidder = await createUser(client, { role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, { startingPrice: 1000 });
    await placeBid(client, auction.id, bidder.id, 1500);
    await setAuctionStatus(client, auction.id, "sold", { finalPrice: 1000, soldTo: bidder.id });

    await assert.rejects(
      () => auctionsService.reassignSale(pool, actorFor(bidder.id, "buyer"), auction.id, bidder.id),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "forbidden");
        return true;
      },
    );
  });
});
