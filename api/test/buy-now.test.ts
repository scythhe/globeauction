import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Client } from "pg";
import {
  buyNow,
  connect,
  createAuction,
  createOrg,
  createUser,
  createVehicle,
  getAuction,
  listBids,
  placeBid,
  reset,
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

async function auctionWithBuyNow(buyNowPrice = 3000, startingPrice = 1000) {
  const owner = await createUser(client, { role: "team" });
  const vehicle = await createVehicle(client, owner.id);
  const auction = await createAuction(client, vehicle.id, owner.id, {
    startingPrice,
    reservePrice: startingPrice,
    buyNowPrice,
  });
  return { owner, vehicle, auction };
}

describe("buy_now — happy path", () => {
  test("closes the auction as sold at exactly the buy-now price", async () => {
    const { auction } = await auctionWithBuyNow(3000);
    const buyer = await createUser(client);

    const result = await buyNow(client, auction.id, buyer.id);

    assert.equal(result.status, "sold");
    assert.equal(Number(result.final_price), 3000);
    assert.equal(Number(result.current_price), 3000);
    assert.equal(result.sold_to, buyer.id);
    assert.ok(result.sold_at);
  });

  test("records a real bid row for the buy-now action, for the same audit trail as ordinary bids", async () => {
    const { auction } = await auctionWithBuyNow(3000);
    const buyer = await createUser(client);

    const result = await buyNow(client, auction.id, buyer.id, "203.0.113.9", "test-agent");

    const bids = await listBids(client, auction.id);
    assert.equal(bids.length, 1);
    assert.equal(bids[0]!.bidder_id, buyer.id);
    assert.equal(Number(bids[0]!.amount), 3000);
    assert.equal(Number(bids[0]!.max_amount), 3000);
    assert.equal(bids[0]!.is_proxy, false);
    assert.equal(bids[0]!.ip_address, "203.0.113.9");
    assert.equal(bids[0]!.user_agent, "test-agent");
    assert.equal(result.high_bid_id, bids[0]!.id);
  });
});

describe("buy_now — validation", () => {
  test("rejects when the auction has no buy-now price set", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id); // no buyNowPrice
    const buyer = await createUser(client);

    await assert.rejects(
      () => buyNow(client, auction.id, buyer.id),
      (err: PgError) => err.message === "buy_now_not_available",
    );
  });

  test("rejects once a real bid already exists — buy-now disappears after the first bid", async () => {
    const { auction } = await auctionWithBuyNow(3000, 1000);
    const firstBidder = await createUser(client, { email: "first@example.com" });
    const buyer = await createUser(client, { email: "buyer@example.com" });

    await placeBid(client, auction.id, firstBidder.id, 1200);

    await assert.rejects(
      () => buyNow(client, auction.id, buyer.id),
      (err: PgError) => err.message === "buy_now_already_bid",
    );
  });

  test("auction_not_live: auction has ended", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id, {
      buyNowPrice: 3000,
      startsAt: new Date(Date.now() - 2 * 60 * 60_000),
      endsAt: new Date(Date.now() - 60_000),
    });
    const buyer = await createUser(client);

    await assert.rejects(
      () => buyNow(client, auction.id, buyer.id),
      (err: PgError) => err.message === "auction_not_live",
    );
  });

  test("auction_not_live: auction is still scheduled", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id, { buyNowPrice: 3000 });
    await client.query("update auctions set status = 'scheduled' where id = $1", [auction.id]);
    const buyer = await createUser(client);

    await assert.rejects(
      () => buyNow(client, auction.id, buyer.id),
      (err: PgError) => err.message === "auction_not_live",
    );
  });

  test("account_inactive", async () => {
    const { auction } = await auctionWithBuyNow();
    const buyer = await createUser(client, { isActive: false });
    await assert.rejects(
      () => buyNow(client, auction.id, buyer.id),
      (err: PgError) => err.message === "account_inactive",
    );
  });

  test("bidding_disabled: can_bid is false", async () => {
    const { auction } = await auctionWithBuyNow();
    const buyer = await createUser(client, { canBid: false });
    await assert.rejects(
      () => buyNow(client, auction.id, buyer.id),
      (err: PgError) => err.message === "bidding_disabled",
    );
  });

  test("bidding_disabled: role is team", async () => {
    const { auction } = await auctionWithBuyNow();
    const teamMember = await createUser(client, { role: "team", canBid: true });
    await assert.rejects(
      () => buyNow(client, auction.id, teamMember.id),
      (err: PgError) => err.message === "bidding_disabled",
    );
  });

  test("own_organization: bidder shares the owner's organization", async () => {
    const org = await createOrg(client);
    const owner = await createUser(client, { role: "team", organizationId: org.id });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id, {
      buyNowPrice: 3000,
      reservePrice: 1000,
    });
    const colleague = await createUser(client, { role: "dealer", organizationId: org.id });

    await assert.rejects(
      () => buyNow(client, auction.id, colleague.id),
      (err: PgError) => err.message === "own_organization",
    );
  });

  // Same bid_limit gap as place_bid() — buy_now() commits a bidder to
  // buy_now_price just as firmly as a proxy bid commits them to max_amount,
  // so it needs the same ceiling.
  test("bid_limit_exceeded: buy_now_price above the bidder's bid_limit is rejected", async () => {
    const { auction } = await auctionWithBuyNow(3000);
    const buyer = await createUser(client, { bidLimit: 2000 });

    await assert.rejects(
      () => buyNow(client, auction.id, buyer.id),
      (err: PgError) => {
        assert.equal(err.message, "bid_limit_exceeded");
        const detail = JSON.parse(err.detail!);
        assert.equal(detail.bid_limit, 2000);
        return true;
      },
    );
  });

  test("allows buy-now exactly at bid_limit", async () => {
    const { auction } = await auctionWithBuyNow(3000);
    const buyer = await createUser(client, { bidLimit: 3000 });

    const result = await buyNow(client, auction.id, buyer.id);
    assert.equal(result.status, "sold");
  });
});

describe("buy_now — concurrency", () => {
  test("exactly one of two simultaneous buy-now calls succeeds", async () => {
    const { auction } = await auctionWithBuyNow(3000);
    const alice = await createUser(client, { email: "alice-bn@example.com" });
    const bob = await createUser(client, { email: "bob-bn@example.com" });

    const clients = await Promise.all([connect(), connect()]);
    try {
      const results = await Promise.allSettled([
        buyNow(clients[0]!, auction.id, alice.id),
        buyNow(clients[1]!, auction.id, bob.id),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1, "exactly one buy-now must succeed");
      assert.equal(rejected.length, 1, "exactly one buy-now must be rejected");

      const finalAuction = await getAuction(client, auction.id);
      assert.equal(finalAuction.status, "sold");
      assert.equal(Number(finalAuction.final_price), 3000);

      const bids = await listBids(client, auction.id);
      assert.equal(bids.length, 1, "only the winning buy-now should have created a bid row");
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });
});
