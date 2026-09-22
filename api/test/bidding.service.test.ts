import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Client, Pool } from "pg";
import * as biddingService from "../src/services/bidding.ts";
import { connect, createAuction, createUser, createVehicle, reset, testPool } from "./helpers.ts";
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

function actorFor(id: string, role: "team" | "buyer" | "dealer" = "buyer"): Actor {
  return { id, role, organizationId: null, canBid: true, isActive: true };
}

// The API response for POST /auctions/:id/bids is whatever placeBid()
// returns. place_bid() itself returns the full bids%rowtype (ip_address,
// user_agent included) even for the bidder's own just-placed bid —
// BACKEND_SPEC.md §12 says those two columns are team-only, full stop, so
// the service layer must strip them before a non-team caller ever sees
// their own response.
describe("bidding.placeBid — ip_address/user_agent are team-only, even on your own bid", () => {
  test("a buyer's own placeBid response has no ip_address/user_agent", async () => {
    const team = await createUser(client, { role: "team" });
    const bidder = await createUser(client, { role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, { startingPrice: 1000 });

    const bid = await biddingService.placeBid(pool, actorFor(bidder.id), auction.id, 1500, {
      ipAddress: "203.0.113.7",
      userAgent: "curl/8.0",
    });

    assert.ok(!("ip_address" in bid));
    assert.ok(!("user_agent" in bid));
    assert.equal(Number((bid as { max_amount: string }).max_amount), 1500);
  });

  test("a dealer's own placeBid response also has no ip_address/user_agent", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, { startingPrice: 1000 });
    const dealer = await createUser(client, { role: "dealer" });

    const bid = await biddingService.placeBid(pool, actorFor(dealer.id, "dealer"), auction.id, 1200, {
      ipAddress: "203.0.113.7",
      userAgent: "curl/8.0",
    });

    assert.ok(!("ip_address" in bid));
    assert.ok(!("user_agent" in bid));
  });
});

// db/010_void_last_bid.sql's batch_id/voided_at/voided_by are internal
// bookkeeping with no meaning to any caller via this response — stripped
// for everyone (team included), unlike ip_address/user_agent which team
// does get to see.
describe("bidding.placeBid — batch_id/voided_at/voided_by never appear in the response", () => {
  test("stripped from a buyer's own response", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, { startingPrice: 1000 });
    const bidder = await createUser(client, { role: "buyer" });

    const bid = await biddingService.placeBid(pool, actorFor(bidder.id), auction.id, 1200);
    assert.ok(!("batch_id" in bid));
    assert.ok(!("voided_at" in bid));
    assert.ok(!("voided_by" in bid));
  });
});

// bids.max_amount is numeric(12,2) — 10 integer digits, 2 decimal. The
// string path validated max_amount against a pattern that (before this
// fix) allowed 15 integer digits, and the number path only checked
// Number.isFinite with no digit cap at all — both let an oversized value
// reach place_bid() and blow up as an unhandled Postgres "numeric field
// overflow" instead of a clean 400. Both call shapes, and both the old
// 11-15-digit gap and the fully-uncapped number path, must reject the
// same way now.
describe("bidding.placeBid — max_amount digit cap matches the actual column width", () => {
  test("an oversized number is rejected the same as an oversized string", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, { startingPrice: 1000 });
    const bidder = await createUser(client, { role: "buyer" });

    await assert.rejects(() => biddingService.placeBid(pool, actorFor(bidder.id), auction.id, 1e26));
    await assert.rejects(() =>
      biddingService.placeBid(pool, actorFor(bidder.id), auction.id, "9".repeat(20)),
    );
  });

  test("11 integer digits is rejected even though it 'looks' finite/short", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, { startingPrice: 1000 });
    const bidder = await createUser(client, { role: "buyer" });

    await assert.rejects(() =>
      biddingService.placeBid(pool, actorFor(bidder.id), auction.id, 12345678901),
    );
    await assert.rejects(() =>
      biddingService.placeBid(pool, actorFor(bidder.id), auction.id, "12345678901"),
    );
  });

  test("a number at the 10-digit boundary is still accepted", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, { startingPrice: 1000 });
    const bidder = await createUser(client, { role: "buyer" });

    const bid = await biddingService.placeBid(pool, actorFor(bidder.id), auction.id, 9999999999.99);
    assert.equal(Number((bid as { max_amount: string }).max_amount), 9999999999.99);
  });
});
