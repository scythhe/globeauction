import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Client, Pool, PoolClient } from "pg";
import * as auctionsRepo from "../src/repositories/auctions.ts";
import {
  connect,
  createAuction,
  createUser,
  createVehicle,
  placeBid,
  reset,
  testPool,
} from "./helpers.ts";

let client: Client;
let pool: Pool;
let poolClient: PoolClient;

before(async () => {
  client = await connect();
  pool = testPool();
  poolClient = await pool.connect();
});

after(async () => {
  poolClient.release();
  await client.end();
  await pool.end();
});

beforeEach(async () => {
  await reset(client);
});

// reserve_met is now computed in SQL (Postgres numeric >= numeric) instead
// of Number(current_price) >= Number(reserve_price) — this decides whether
// a car legally sells, so it must never go through a JS float comparison
// (CLAUDE.md hard rule #1). No prior test exercised either branch at all.
describe("auctionsRepo.closeExpiredAuctions", () => {
  test("reserve met: closes as sold", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id, {
      startingPrice: 1000,
      reservePrice: 1000,
    });
    const bidder = await createUser(client);
    await placeBid(client, auction.id, bidder.id, 1500);
    // bonus_extension_used: true — this test is about the reserve-met
    // close branch, not the db/012 bonus round, which has its own tests.
    await client.query(
      "update auctions set ends_at = now() - interval '1 second', bonus_extension_used = true where id = $1",
      [auction.id],
    );

    const closed = await auctionsRepo.closeExpiredAuctions(poolClient);
    assert.deepEqual(closed, [{ id: auction.id, outcome: "sold" }]);

    const { rows } = await client.query("select status, final_price, sold_to from auctions where id = $1", [
      auction.id,
    ]);
    assert.equal(rows[0]!.status, "sold");
    assert.equal(Number(rows[0]!.final_price), 1000);
    assert.equal(rows[0]!.sold_to, bidder.id);
  });

  test("reserve not met: moves to pending_seller", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id, {
      startingPrice: 1000,
      reservePrice: 5000,
    });
    const bidder = await createUser(client);
    await placeBid(client, auction.id, bidder.id, 1200);
    await client.query(
      "update auctions set ends_at = now() - interval '1 second', bonus_extension_used = true where id = $1",
      [auction.id],
    );

    const closed = await auctionsRepo.closeExpiredAuctions(poolClient);
    assert.deepEqual(closed, [{ id: auction.id, outcome: "pending_seller" }]);

    const { rows } = await client.query(
      "select status, seller_decision_by from auctions where id = $1",
      [auction.id],
    );
    assert.equal(rows[0]!.status, "pending_seller");
    assert.ok(rows[0]!.seller_decision_by);
  });

  test("current_price exactly equal to reserve_price counts as met, not below", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id, {
      startingPrice: 1000,
      reservePrice: 1000,
    });
    const bidder = await createUser(client);
    await placeBid(client, auction.id, bidder.id, 1000);
    await client.query(
      "update auctions set ends_at = now() - interval '1 second', bonus_extension_used = true where id = $1",
      [auction.id],
    );

    const closed = await auctionsRepo.closeExpiredAuctions(poolClient);
    assert.deepEqual(closed, [{ id: auction.id, outcome: "sold" }]);
  });

  test("no bids at all: closes as unsold", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id, {
      startingPrice: 1000,
      endsAt: new Date(Date.now() - 1000),
    });

    const closed = await auctionsRepo.closeExpiredAuctions(poolClient);
    assert.deepEqual(closed, [{ id: auction.id, outcome: "unsold" }]);
  });

  // db/012: a separate, one-time mechanic from place_bid()'s own per-bid
  // soft close. First quiet close with a winner in place grants a single
  // bonus round instead of closing; the second quiet close (bonus already
  // spent) closes for real.
  test("winner in place, bonus not yet used: grants one bonus round instead of closing", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id, {
      startingPrice: 1000,
      reservePrice: 1000,
    });
    const bidder = await createUser(client);
    await placeBid(client, auction.id, bidder.id, 1500);
    await client.query("update auctions set ends_at = now() - interval '1 second' where id = $1", [
      auction.id,
    ]);

    const result = await auctionsRepo.closeExpiredAuctions(poolClient);
    assert.deepEqual(result, [{ id: auction.id, outcome: "extended" }]);

    const { rows } = await client.query(
      "select status, ends_at, bonus_extension_used from auctions where id = $1",
      [auction.id],
    );
    assert.equal(rows[0]!.status, "live");
    assert.equal(rows[0]!.bonus_extension_used, true);
    assert.ok(new Date(rows[0]!.ends_at).getTime() > Date.now());
  });

  test("bonus already used: second quiet close closes for real", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id, {
      startingPrice: 1000,
      reservePrice: 1000,
    });
    const bidder = await createUser(client);
    await placeBid(client, auction.id, bidder.id, 1500);
    await client.query(
      "update auctions set ends_at = now() - interval '1 second', bonus_extension_used = true where id = $1",
      [auction.id],
    );

    const result = await auctionsRepo.closeExpiredAuctions(poolClient);
    assert.deepEqual(result, [{ id: auction.id, outcome: "sold" }]);

    const { rows } = await client.query("select status from auctions where id = $1", [auction.id]);
    assert.equal(rows[0]!.status, "sold");
  });

  test("bonus round does not apply twice in the same job pass", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id, {
      startingPrice: 1000,
      reservePrice: 1000,
    });
    const bidder = await createUser(client);
    await placeBid(client, auction.id, bidder.id, 1500);
    await client.query("update auctions set ends_at = now() - interval '1 second' where id = $1", [
      auction.id,
    ]);

    const first = await auctionsRepo.closeExpiredAuctions(poolClient);
    assert.deepEqual(first, [{ id: auction.id, outcome: "extended" }]);

    // Bonus was granted with a fresh ends_at in the future, so a second
    // pass right now must not find it a candidate at all — not "already
    // extended," genuinely not due to close yet.
    const second = await auctionsRepo.closeExpiredAuctions(poolClient);
    assert.deepEqual(second, []);
  });
});
