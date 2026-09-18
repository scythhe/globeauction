import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Client } from "pg";
import {
  connect,
  createAuction,
  createUser,
  createVehicle,
  getAuction,
  listBids,
  placeBid,
  reset,
  voidLastBid,
  type PgError,
} from "./helpers.ts";

let client: Client;

before(async () => {
  client = await connect();
});

after(async () => {
  await client.end();
});

beforeEach(async () => {
  await reset(client);
});

async function basicAuction(startingPrice = 1000) {
  const owner = await createUser(client, { role: "team" });
  const vehicle = await createVehicle(client, owner.id);
  const auction = await createAuction(client, vehicle.id, owner.id, { startingPrice });
  return { owner, vehicle, auction };
}

// db/010_void_last_bid.sql. Scope decided with the business: erase the
// mistaken bid entirely (soft-delete) and have the bidder re-bid — not an
// in-place correction — and only while it's still the most recent action
// on a live auction.
describe("void_last_bid — case A: the only bid", () => {
  test("removes the bid, restores current_price to starting_price, clears high_bid_id", async () => {
    const { owner, auction } = await basicAuction(1000);
    const alice = await createUser(client);
    const placed = await placeBid(client, auction.id, alice.id, 1_250_000); // typo'd

    const result = await voidLastBid(client, auction.id, owner.id);
    assert.equal(Number(result.current_price), 1000);
    assert.equal(result.high_bid_id, null);
    assert.equal(result.last_bid_batch_id, null);

    const bids = await listBids(client, auction.id);
    assert.equal(bids.length, 1, "soft-deleted, not hard-deleted");
    assert.equal(bids[0]!.id, placed.id);
    assert.ok(bids[0]!.voided_at);
    assert.equal(bids[0]!.voided_by, owner.id);
  });

  test("logs a bid_voided auction_event with the mistaken amount and who voided it", async () => {
    const { owner, auction } = await basicAuction(1000);
    const alice = await createUser(client);
    await placeBid(client, auction.id, alice.id, 1_250_000);

    await voidLastBid(client, auction.id, owner.id);

    const { rows } = await client.query(
      "select * from auction_events where auction_id = $1",
      [auction.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.event_type, "bid_voided");
    assert.equal(rows[0]!.actor_id, owner.id);
    assert.equal(rows[0]!.detail.bidder_id, alice.id);
    assert.equal(Number(rows[0]!.detail.max_amount), 1_250_000);
  });

  test("after voiding, the bidder can re-bid at the original minimum", async () => {
    const { owner, auction } = await basicAuction(1000);
    const alice = await createUser(client);
    await placeBid(client, auction.id, alice.id, 1_250_000);
    await voidLastBid(client, auction.id, owner.id);

    const rebid = await placeBid(client, auction.id, alice.id, 1200);
    assert.equal(Number(rebid.amount), 1000, "back to Case A — inserts at starting_price");
  });
});

describe("void_last_bid — case C: challenger took the lead", () => {
  test("restores the previous leader's original row and current_price", async () => {
    const { owner, auction } = await basicAuction(1000);
    const alice = await createUser(client);
    const bob = await createUser(client);

    const aliceBid = await placeBid(client, auction.id, alice.id, 5000);
    await placeBid(client, auction.id, bob.id, 999_999_999); // bob's typo

    const result = await voidLastBid(client, auction.id, owner.id);
    assert.equal(result.high_bid_id, aliceBid.id);
    assert.equal(Number(result.current_price), 1000);

    const bids = await listBids(client, auction.id);
    assert.equal(bids.length, 3, "alice's original + her proxy row + bob's row, all still present");
    const [alicesOriginal, alicesProxy, bobsRow] = bids;
    assert.equal(alicesOriginal!.voided_at, null, "alice's real bid must not be touched");
    assert.ok(alicesProxy!.voided_at, "the proxy row bob's bid created must be voided too");
    assert.ok(bobsRow!.voided_at);
  });

  test("the restored leader's own new bid works normally afterward", async () => {
    const { owner, auction } = await basicAuction(1000);
    const alice = await createUser(client);
    const bob = await createUser(client);
    await placeBid(client, auction.id, alice.id, 5000);
    await placeBid(client, auction.id, bob.id, 999_999_999);
    await voidLastBid(client, auction.id, owner.id);

    // alice raises her own ceiling (case B) — should work against the
    // restored state, not the voided one.
    const raised = await placeBid(client, auction.id, alice.id, 6000);
    assert.equal(Number(raised.max_amount), 6000);
  });
});

describe("void_last_bid — case D: challenger did not take the lead", () => {
  test("restores current_price to what it was before the challenger's bid", async () => {
    const { owner, auction } = await basicAuction(1000);
    const alice = await createUser(client);
    const bob = await createUser(client);

    await placeBid(client, auction.id, alice.id, 5000); // case A: current_price 1000
    await placeBid(client, auction.id, bob.id, 1200); // case D: alice pushed up, current_price moves

    const beforeVoid = await getAuction(client, auction.id);
    assert.ok(Number(beforeVoid.current_price) > 1000, "sanity: bob's bid did move the price");

    const result = await voidLastBid(client, auction.id, owner.id);
    assert.equal(Number(result.current_price), 1000);

    const bids = await listBids(client, auction.id);
    const activeBids = bids.filter((b) => !b.voided_at);
    assert.equal(activeBids.length, 1);
    assert.equal(Number(activeBids[0]!.amount), 1000);
    assert.equal(Number(activeBids[0]!.max_amount), 5000);
  });
});

describe("void_last_bid — not voidable", () => {
  test("rejects when the most recent action was a ceiling raise (case B)", async () => {
    const { owner, auction } = await basicAuction(1000);
    const alice = await createUser(client);
    await placeBid(client, auction.id, alice.id, 2000);
    await placeBid(client, auction.id, alice.id, 3000); // case B: raise

    await assert.rejects(
      () => voidLastBid(client, auction.id, owner.id),
      (err: PgError) => err.message === "bid_not_voidable",
    );

    // and nothing changed
    const bids = await listBids(client, auction.id);
    assert.equal(bids.filter((b) => b.voided_at).length, 0);
  });

  test("rejects when there are no bids at all", async () => {
    const { owner, auction } = await basicAuction(1000);
    await assert.rejects(
      () => voidLastBid(client, auction.id, owner.id),
      (err: PgError) => err.message === "bid_not_voidable",
    );
  });

  test("rejects voiding twice in a row for the same event", async () => {
    const { owner, auction } = await basicAuction(1000);
    const alice = await createUser(client);
    await placeBid(client, auction.id, alice.id, 2000);

    await voidLastBid(client, auction.id, owner.id);
    await assert.rejects(
      () => voidLastBid(client, auction.id, owner.id),
      (err: PgError) => err.message === "bid_not_voidable",
    );
  });

  test("rejects once a newer bid has landed on top of the one you wanted to void", async () => {
    const { owner, auction } = await basicAuction(1000);
    const alice = await createUser(client);
    const bob = await createUser(client);
    await placeBid(client, auction.id, alice.id, 2000);
    await placeBid(client, auction.id, bob.id, 3000); // now the most recent

    // Voiding still succeeds (it targets bob's action, the actual most
    // recent one) — this just confirms it's bob's bid that gets voided,
    // not alice's earlier one, when both exist.
    const result = await voidLastBid(client, auction.id, owner.id);
    const bids = await listBids(client, auction.id);
    const bobsBid = bids.find((b) => b.bidder_id === bob.id && !b.is_proxy);
    assert.ok(bobsBid!.voided_at, "bob's bid (the actual most recent) is what gets voided");
    assert.equal(result.high_bid_id, bids.find((b) => b.bidder_id === alice.id)!.id);
  });

  test("rejects on a non-live auction", async () => {
    const { owner, auction } = await basicAuction(1000);
    const alice = await createUser(client);
    await placeBid(client, auction.id, alice.id, 2000);
    await client.query("update auctions set status = 'cancelled' where id = $1", [auction.id]);

    await assert.rejects(
      () => voidLastBid(client, auction.id, owner.id),
      (err: PgError) => err.message === "auction_not_live",
    );
  });

  test("voiding can be chained: void, bid again, void again", async () => {
    const { owner, auction } = await basicAuction(1000);
    const alice = await createUser(client);

    await placeBid(client, auction.id, alice.id, 2000);
    await voidLastBid(client, auction.id, owner.id);
    await placeBid(client, auction.id, alice.id, 3000);
    const result = await voidLastBid(client, auction.id, owner.id);

    assert.equal(result.high_bid_id, null);
    assert.equal(Number(result.current_price), 1000);
    const bids = await listBids(client, auction.id);
    assert.equal(bids.length, 2);
    assert.ok(bids.every((b) => b.voided_at));
  });
});

describe("void_last_bid — concurrency", () => {
  test("two simultaneous void calls: exactly one succeeds", async () => {
    const { owner, auction } = await basicAuction(1000);
    const alice = await createUser(client);
    await placeBid(client, auction.id, alice.id, 2000);

    const clients = await Promise.all([connect(), connect()]);
    try {
      const results = await Promise.allSettled([
        clients[0]!.query("select * from void_last_bid($1, $2)", [auction.id, owner.id]),
        clients[1]!.query("select * from void_last_bid($1, $2)", [auction.id, owner.id]),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);

      const bids = await listBids(client, auction.id);
      assert.equal(bids.filter((b) => b.voided_at).length, 1, "only one voided_at should be set");
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });
});
