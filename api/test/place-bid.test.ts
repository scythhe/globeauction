import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Client } from "pg";
import {
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
  type UserFixture,
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

describe("place_bid — case A: no existing bid", () => {
  test("inserts a bid at starting_price and sets it as the high bid", async () => {
    const { auction } = await basicAuction(1000);
    const bidder = await createUser(client);

    const result = await placeBid(client, auction.id, bidder.id, 1500);

    assert.equal(Number(result.amount), 1000);
    assert.equal(Number(result.max_amount), 1500);
    assert.equal(result.is_proxy, false);

    const updated = await getAuction(client, auction.id);
    assert.equal(Number(updated.current_price), 1000);
    assert.equal(updated.high_bid_id, result.id);

    const bids = await listBids(client, auction.id);
    assert.equal(bids.length, 1);
  });

  test("records ip_address and user_agent on the bidder's own row (§5.1)", async () => {
    const { auction } = await basicAuction(1000);
    const bidder = await createUser(client);

    const result = await placeBid(client, auction.id, bidder.id, 1500, "203.0.113.7", "curl/8.0");

    assert.equal(result.ip_address, "203.0.113.7");
    assert.equal(result.user_agent, "curl/8.0");
  });

  test("does not record ip_address/user_agent on the old holder's proxy row (case C)", async () => {
    const { auction } = await basicAuction(1000);
    const alice = await createUser(client, { email: "alice-ip@example.com" });
    const bob = await createUser(client, { email: "bob-ip@example.com" });

    await placeBid(client, auction.id, alice.id, 1200, "203.0.113.1", "alice-agent");
    await placeBid(client, auction.id, bob.id, 2000, "203.0.113.2", "bob-agent");

    const bids = await listBids(client, auction.id);
    const aliceProxy = bids.find((b) => b.bidder_id === alice.id && b.is_proxy);
    assert.ok(aliceProxy);
    assert.equal(aliceProxy!.ip_address, null, "proxy rows are system-generated, not a fresh request");
    assert.equal(aliceProxy!.user_agent, null);
  });
});

describe("place_bid — case B: bidder already holds the high bid", () => {
  test("raises their max_amount without inserting a new bid", async () => {
    const { auction } = await basicAuction(1000);
    const bidder = await createUser(client);

    const first = await placeBid(client, auction.id, bidder.id, 1500);
    const second = await placeBid(client, auction.id, bidder.id, 2000);

    assert.equal(second.id, first.id);
    assert.equal(Number(second.max_amount), 2000);
    assert.equal(Number(second.amount), 1000);

    const updated = await getAuction(client, auction.id);
    assert.equal(Number(updated.current_price), 1000, "current_price must not move");
    assert.equal(updated.high_bid_id, first.id);

    const bids = await listBids(client, auction.id);
    assert.equal(bids.length, 1, "raising your own ceiling must not create a new row");
  });

  test("still enforces the standard minimum (current_price + increment)", async () => {
    const { auction } = await basicAuction(1000);
    const bidder = await createUser(client);
    await placeBid(client, auction.id, bidder.id, 1500);

    // current_price is 1000, increment at 1000 is 100 -> min next max_amount is 1100.
    await assert.rejects(
      () => placeBid(client, auction.id, bidder.id, 1050),
      (err: PgError) => err.message === "bid_too_low",
    );
  });

  // BACKEND_SPEC.md §5.3 Case B: "This is a bidder increasing their own
  // ceiling" — raise-only. The generic current_price+increment floor isn't
  // enough to guarantee that: it's computed from current_price, which
  // Case B never moves, so a bidder holding a much higher max_amount could
  // call place_bid again with a *lower* value that still clears that floor
  // and silently drop their own ceiling — undermining the proxy-bidding
  // guarantee that a leading max_amount only ever goes up.
  test("rejects a same-bidder call that would lower their existing max_amount", async () => {
    const { auction } = await basicAuction(1000);
    const bidder = await createUser(client);
    await placeBid(client, auction.id, bidder.id, 1500);

    // 1200 clears the generic floor (current_price 1000 + increment 100 = 1100)
    // but is still below the bidder's existing ceiling of 1500.
    await assert.rejects(
      () => placeBid(client, auction.id, bidder.id, 1200),
      (err: PgError) => err.message === "bid_too_low",
    );

    const bids = await listBids(client, auction.id);
    assert.equal(bids.length, 1);
    assert.equal(Number(bids[0]!.max_amount), 1500, "ceiling must be unchanged after the rejected call");
  });
});

describe("place_bid — case C: new max_amount beats the existing max", () => {
  test("proxies the old holder up and gives the new bidder the lead", async () => {
    const { auction } = await basicAuction(1000);
    const alice = await createUser(client, { email: "alice@example.com" });
    const bob = await createUser(client, { email: "bob@example.com" });

    const aliceBid = await placeBid(client, auction.id, alice.id, 1200);
    assert.equal(Number(aliceBid.amount), 1000);

    // current_price now 1000, increment 100. Bob's max (2000) beats alice's max (1200).
    const bobBid = await placeBid(client, auction.id, bob.id, 2000);

    // alice should be proxied up to her own max (1200) — she's now outbid.
    const bids = await listBids(client, auction.id);
    assert.equal(bids.length, 3, "alice's original bid + alice's proxy + bob's bid");

    const aliceProxy = bids.find(
      (b) => b.bidder_id === alice.id && b.is_proxy && b.id !== aliceBid.id,
    );
    assert.ok(aliceProxy, "expected a proxy bid for alice");
    assert.equal(Number(aliceProxy!.amount), 1200);
    assert.equal(Number(aliceProxy!.max_amount), 1200);

    // bob's standing amount = min(alice.max + increment(1000), bob.max) = min(1200+100, 2000) = 1300
    assert.equal(Number(bobBid.amount), 1300);
    assert.equal(Number(bobBid.max_amount), 2000);
    assert.equal(bobBid.is_proxy, false);

    const updated = await getAuction(client, auction.id);
    assert.equal(Number(updated.current_price), 1300);
    assert.equal(updated.high_bid_id, bobBid.id);
  });
});

describe("place_bid — case D: new max_amount does not beat the existing max", () => {
  test("the old holder keeps the lead, pushed up just enough", async () => {
    const { auction } = await basicAuction(1000);
    const alice = await createUser(client, { email: "alice@example.com" });
    const bob = await createUser(client, { email: "bob@example.com" });

    await placeBid(client, auction.id, alice.id, 2000);
    // current_price now 1000, increment 100. Bob's max (1300) does not beat alice's max (2000).
    const bobBid = await placeBid(client, auction.id, bob.id, 1300);

    assert.equal(Number(bobBid.amount), 1300);
    assert.equal(Number(bobBid.max_amount), 1300);
    assert.equal(bobBid.is_proxy, false, "bob's own row records his loss, not a proxy");

    const updated = await getAuction(client, auction.id);
    // alice proxied to min(bob.max + increment(1000), alice.max) = min(1300+100, 2000) = 1400
    assert.equal(Number(updated.current_price), 1400);

    const bids = await listBids(client, auction.id);
    const highBid = bids.find((b) => b.id === updated.high_bid_id);
    assert.ok(highBid);
    assert.equal(highBid!.bidder_id, alice.id);
    assert.equal(highBid!.is_proxy, true);
    assert.equal(Number(highBid!.amount), 1400);
  });
});

describe("place_bid — case E: exact tie on maximums", () => {
  test("falls under case D — the earlier (existing) holder keeps the lead", async () => {
    const { auction } = await basicAuction(1000);
    const alice = await createUser(client, { email: "alice@example.com" });
    const bob = await createUser(client, { email: "bob@example.com" });

    await placeBid(client, auction.id, alice.id, 1500);
    await placeBid(client, auction.id, bob.id, 1500); // exact tie

    const updated = await getAuction(client, auction.id);
    const bids = await listBids(client, auction.id);
    const highBid = bids.find((b) => b.id === updated.high_bid_id);

    assert.ok(highBid);
    assert.equal(highBid!.bidder_id, alice.id, "alice held the tie first, she keeps it");
  });
});

describe("place_bid — flat bids (Monster Bid / pre-bidding)", () => {
  test("case A: a flat first bid publishes its own number, not starting_price", async () => {
    const { auction } = await basicAuction(1000);
    const bidder = await createUser(client);

    const result = await placeBid(client, auction.id, bidder.id, 5000, null, null, true);
    assert.equal(Number(result.amount), 5000);
    assert.equal(Number(result.max_amount), 5000);

    const updated = await getAuction(client, auction.id);
    assert.equal(Number(updated.current_price), 5000);
  });

  test("case B: a flat self-raise moves current_price to the new number", async () => {
    const { auction } = await basicAuction(1000);
    const bidder = await createUser(client);

    await placeBid(client, auction.id, bidder.id, 1500);
    let updated = await getAuction(client, auction.id);
    assert.equal(Number(updated.current_price), 1000, "ordinary bid rests at starting_price, no rival yet");

    await placeBid(client, auction.id, bidder.id, 3000, null, null, true);
    updated = await getAuction(client, auction.id);
    assert.equal(Number(updated.current_price), 3000, "flat raise publishes the new ceiling immediately");
  });

  test("case C: a flat bid that takes the lead shows its own full number, not rival-max+increment", async () => {
    const { auction } = await basicAuction(1000);
    const alice = await createUser(client, { email: "alice@example.com" });
    const bob = await createUser(client, { email: "bob@example.com" });

    await placeBid(client, auction.id, alice.id, 1200);
    // Ordinary Case C would land bob at min(1200+100, 5000) = 1300. Flat
    // skips that compression and shows bob's own 5000 outright.
    const bobBid = await placeBid(client, auction.id, bob.id, 5000, null, null, true);

    assert.equal(Number(bobBid.amount), 5000);
    assert.equal(Number(bobBid.max_amount), 5000);

    const updated = await getAuction(client, auction.id);
    assert.equal(Number(updated.current_price), 5000);
    assert.equal(updated.high_bid_id, bobBid.id);
  });

  test("case D: a flat bid below a rival's real max still loses to it", async () => {
    const { auction } = await basicAuction(1000);
    const alice = await createUser(client, { email: "alice@example.com" });
    const bob = await createUser(client, { email: "bob@example.com" });

    await placeBid(client, auction.id, alice.id, 10_000);
    // Bob's flat bid of 4000 clears the floor (starting_price 1000) but is
    // nowhere near alice's real ceiling — flat must not let him win anyway.
    const bobBid = await placeBid(client, auction.id, bob.id, 4000, null, null, true);

    assert.equal(Number(bobBid.amount), 4000);
    assert.equal(bobBid.is_proxy, false, "bob's own row records his loss, not a proxy");

    const updated = await getAuction(client, auction.id);
    // alice proxied to min(bob.max + increment(1000), alice.max) = min(4000+100, 10000) = 4100
    assert.equal(Number(updated.current_price), 4100);

    const bids = await listBids(client, auction.id);
    const highBid = bids.find((b) => b.id === updated.high_bid_id);
    assert.ok(highBid);
    assert.equal(highBid!.bidder_id, alice.id, "alice's genuinely higher max still wins");
  });

  test("a non-flat (Quick Bid) call is completely unaffected by the new default", async () => {
    const { auction } = await basicAuction(1000);
    const alice = await createUser(client, { email: "alice@example.com" });
    const bob = await createUser(client, { email: "bob@example.com" });

    await placeBid(client, auction.id, alice.id, 1200);
    const bobBid = await placeBid(client, auction.id, bob.id, 2000);

    assert.equal(Number(bobBid.amount), 1300, "ordinary Case C proxy compression, unchanged");
  });
});

describe("place_bid — validation", () => {
  test("bid_too_low: below starting_price with no existing bid", async () => {
    const { auction } = await basicAuction(1000);
    const bidder = await createUser(client);

    await assert.rejects(
      () => placeBid(client, auction.id, bidder.id, 999),
      (err: PgError) => {
        assert.equal(err.message, "bid_too_low");
        const detail = JSON.parse(err.detail!);
        assert.equal(detail.minimum, 1000);
        return true;
      },
    );
  });

  test("auction_not_live: auction not yet open", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id, {
      startsAt: new Date(Date.now() + 60 * 60_000),
      endsAt: new Date(Date.now() + 2 * 60 * 60_000),
    });
    const bidder = await createUser(client);

    await assert.rejects(
      () => placeBid(client, auction.id, bidder.id, 1000),
      (err: PgError) => err.message === "auction_not_live",
    );
  });

  test("auction_not_live: status is anything other than live/scheduled", async () => {
    const bidder = await createUser(client);

    for (const status of ["unsold", "cancelled", "pending_seller", "counter_offered"]) {
      const { auction } = await basicAuction();
      await client.query("update auctions set status = $2 where id = $1", [auction.id, status]);
      await assert.rejects(
        () => placeBid(client, auction.id, bidder.id, 1000),
        (err: PgError) => err.message === "auction_not_live",
        `expected status=${status} to reject`,
      );
    }

    // 'sold' carries its own required columns (auctions_sold constraint).
    const { auction: soldAuction } = await basicAuction();
    await client.query(
      "update auctions set status = 'sold', final_price = 1000, sold_to = $2 where id = $1",
      [soldAuction.id, bidder.id],
    );
    await assert.rejects(
      () => placeBid(client, soldAuction.id, bidder.id, 1000),
      (err: PgError) => err.message === "auction_not_live",
    );
  });

  test("bidding_disabled: can_bid is false", async () => {
    const { auction } = await basicAuction();
    const bidder = await createUser(client, { canBid: false });

    await assert.rejects(
      () => placeBid(client, auction.id, bidder.id, 1000),
      (err: PgError) => err.message === "bidding_disabled",
    );
  });

  test("bidding_disabled: role is team", async () => {
    const { auction } = await basicAuction();
    const teamMember = await createUser(client, { role: "team", canBid: true });

    await assert.rejects(
      () => placeBid(client, auction.id, teamMember.id, 1000),
      (err: PgError) => err.message === "bidding_disabled",
    );
  });

  test("account_inactive: bidder is not active", async () => {
    const { auction } = await basicAuction();
    const bidder = await createUser(client, { isActive: false });

    await assert.rejects(
      () => placeBid(client, auction.id, bidder.id, 1000),
      (err: PgError) => err.message === "account_inactive",
    );
  });

  test("own_organization: bidder is the vehicle owner", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id);

    // The owner account itself is 'team' (bidding_disabled would also fire) —
    // use a buyer who owns the vehicle to isolate the own_organization check.
    const ownerBuyer = await createUser(client, { role: "buyer" });
    await client.query("update vehicles set owner_id = $1 where id = $2", [
      ownerBuyer.id,
      vehicle.id,
    ]);

    await assert.rejects(
      () => placeBid(client, auction.id, ownerBuyer.id, 1000),
      (err: PgError) => err.message === "own_organization",
    );
  });

  test("own_organization: bidder shares the owner's organization", async () => {
    const org = await createOrg(client);
    const owner = await createUser(client, { role: "team", organizationId: org.id });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id);

    const colleague = await createUser(client, { role: "dealer", organizationId: org.id });

    await assert.rejects(
      () => placeBid(client, auction.id, colleague.id, 1000),
      (err: PgError) => err.message === "own_organization",
    );
  });

  test("a bidder with no organization is not blocked by a null-vs-null match", async () => {
    const owner = await createUser(client, { role: "team", organizationId: null });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id);
    const bidder = await createUser(client, { organizationId: null });

    const result = await placeBid(client, auction.id, bidder.id, 1000);
    assert.ok(result.id);
  });

  // BACKEND_SPEC.md §2.1: bid_limit "caps total exposure ... convention is
  // deposit_amount × 10." Found by review, not a pentest: the column was
  // computed on every deposit and shown in the admin UI, but neither
  // place_bid() nor buy_now() ever read it — a 500₾ minimum deposit
  // (bid_limit 5,000₾) placed no ceiling at all on what someone could bid.
  test("bid_limit_exceeded: max_amount above the bidder's bid_limit is rejected", async () => {
    const { auction } = await basicAuction(1000);
    const bidder = await createUser(client, { bidLimit: 5000 });

    await assert.rejects(
      () => placeBid(client, auction.id, bidder.id, 5001),
      (err: PgError) => {
        assert.equal(err.message, "bid_limit_exceeded");
        const detail = JSON.parse(err.detail!);
        assert.equal(detail.bid_limit, 5000);
        return true;
      },
    );

    const bids = await listBids(client, auction.id);
    assert.equal(bids.length, 0, "the rejected bid must not have been inserted");
  });

  test("a max_amount exactly at bid_limit is allowed", async () => {
    const { auction } = await basicAuction(1000);
    const bidder = await createUser(client, { bidLimit: 5000 });

    const result = await placeBid(client, auction.id, bidder.id, 5000);
    assert.ok(result.id);
  });

  test("bid_limit is null (never deposited) — no ceiling, other checks still apply", async () => {
    const { auction } = await basicAuction(1000);
    // can_bid defaults true in the fixture, mirroring an operator who
    // manually enabled bidding without going through the deposit flow —
    // bid_limit staying null shouldn't silently become "unlimited by bug",
    // but it also isn't this function's job to require a deposit; that's
    // the can_bid gate's job (already covered by the bidding_disabled tests).
    const bidder = await createUser(client, { bidLimit: null });

    const result = await placeBid(client, auction.id, bidder.id, 999_999);
    assert.ok(result.id);
  });

  // Case B (raising your own ceiling) and Case C (taking the lead over
  // someone else) both submit a fresh p_max_amount and must be capped the
  // same way as a first bid — the limit isn't a one-time gate on Case A.
  test("bid_limit_exceeded also applies when raising your own ceiling (case B)", async () => {
    const { auction } = await basicAuction(1000);
    const bidder = await createUser(client, { bidLimit: 5000 });
    await placeBid(client, auction.id, bidder.id, 4000);

    await assert.rejects(
      () => placeBid(client, auction.id, bidder.id, 5001),
      (err: PgError) => err.message === "bid_limit_exceeded",
    );
  });

  test("bid_limit_exceeded also applies when taking the lead over another bidder (case C)", async () => {
    const { auction } = await basicAuction(1000);
    const leader = await createUser(client);
    await placeBid(client, auction.id, leader.id, 4000);

    const challenger = await createUser(client, { bidLimit: 5000 });
    await assert.rejects(
      () => placeBid(client, auction.id, challenger.id, 5001),
      (err: PgError) => err.message === "bid_limit_exceeded",
    );
  });
});

describe("place_bid — soft close", () => {
  test("extends ends_at when remaining time is less than the extension", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id, {
      endsAt: new Date(Date.now() + 5_000), // 5s left, less than the 15s extension
      softCloseTrigger: "5 minutes",
      softCloseExtension: "15 seconds",
    });
    const bidder = await createUser(client);

    const before = await getAuction(client, auction.id);
    await placeBid(client, auction.id, bidder.id, 1500);
    const after = await getAuction(client, auction.id);

    assert.ok(
      new Date(after.ends_at).getTime() > new Date(before.ends_at).getTime(),
      "ends_at should have moved forward",
    );
  });

  // The whole point of splitting soft_close_window into a trigger and an
  // extension: a contested auction shouldn't balloon by another full
  // 5-minute trigger window every time someone bids in the last few
  // minutes — it should get pushed out by the much shorter extension
  // instead. Written to catch a regression back to "one value does both
  // jobs" (found by review, not a pentest — see db/011).
  test("extends by soft_close_extension, not by soft_close_trigger", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id, {
      endsAt: new Date(Date.now() + 5_000),
      softCloseTrigger: "5 minutes",
      softCloseExtension: "15 seconds",
    });
    const bidder = await createUser(client);

    const beforeCall = Date.now();
    await placeBid(client, auction.id, bidder.id, 1500);
    const after = await getAuction(client, auction.id);

    const extension = new Date(after.ends_at).getTime() - beforeCall;
    assert.ok(extension < 60_000, "must be extended by ~15s (the extension), not ~5min (the trigger)");
    assert.ok(extension > 5_000, "sanity: still meaningfully extended, not left alone");
  });

  // The actual bug the GREATEST fix (db/011) covers: a bid landing inside
  // the 5-minute trigger window but with *more* time left than the 15s
  // extension would provide must not have its deadline pulled backward
  // to a bare "now + extension."
  test("does not move ends_at when remaining time already exceeds the extension", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const farerEnd = new Date(Date.now() + 30_000); // 30s left: inside the 5-min trigger, but > the 15s extension
    const auction = await createAuction(client, vehicle.id, owner.id, {
      endsAt: farerEnd,
      softCloseTrigger: "5 minutes",
      softCloseExtension: "15 seconds",
    });
    const bidder = await createUser(client);

    await placeBid(client, auction.id, bidder.id, 1500);
    const after = await getAuction(client, auction.id);

    assert.equal(new Date(after.ends_at).getTime(), farerEnd.getTime());
  });

  test("does not shorten ends_at when the bid lands outside the trigger window", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const farEnd = new Date(Date.now() + 60 * 60_000);
    const auction = await createAuction(client, vehicle.id, owner.id, {
      endsAt: farEnd,
      softCloseTrigger: "5 minutes",
      softCloseExtension: "15 seconds",
    });
    const bidder = await createUser(client);

    await placeBid(client, auction.id, bidder.id, 1500);
    const after = await getAuction(client, auction.id);

    assert.equal(new Date(after.ends_at).getTime(), farEnd.getTime());
  });

  test("extension is repeatable — a second bid inside the (renewed) window extends again", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id, {
      endsAt: new Date(Date.now() + 10_000),
      softCloseTrigger: "5 minutes",
      softCloseExtension: "15 seconds",
    });
    const alice = await createUser(client);
    const bob = await createUser(client);

    await placeBid(client, auction.id, alice.id, 1500);
    const afterFirst = await getAuction(client, auction.id);

    await placeBid(client, auction.id, bob.id, 2000);
    const afterSecond = await getAuction(client, auction.id);

    assert.ok(
      new Date(afterSecond.ends_at).getTime() > new Date(afterFirst.ends_at).getTime(),
      "the second bid must extend again, not just once",
    );
  });
});

describe("place_bid — concurrency", () => {
  test("parallel competing bids resolve without corrupting current_price/high_bid_id", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id, { startingPrice: 1000 });

    const bidderCount = 5;
    const bidders: UserFixture[] = [];
    for (let i = 0; i < bidderCount; i++) {
      bidders.push(await createUser(client, { email: `concurrent-${i}@example.com` }));
    }

    // Each bidder gets their own connection — place_bid's FOR UPDATE lock
    // must serialize these, not the single-connection query queue.
    const clients = await Promise.all(bidders.map(() => connect()));

    try {
      const results = await Promise.allSettled(
        clients.map((c, i) => placeBid(c, auction.id, bidders[i]!.id, 2000 + i * 100)),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      assert.ok(fulfilled.length >= 1, "at least one bid should have succeeded");

      const updated = await getAuction(client, auction.id);
      const bids = await listBids(client, auction.id);

      const highBid = bids.find((b) => b.id === updated.high_bid_id);
      assert.ok(highBid, "high_bid_id must point at a real bid row");
      assert.equal(
        Number(highBid!.amount),
        Number(updated.current_price),
        "invariant: current_price must equal the amount of the high bid (BACKEND_SPEC.md §13 invariant 1)",
      );

      for (const b of bids) {
        assert.ok(
          b.max_amount === null || Number(b.max_amount) >= Number(b.amount),
          "invariant: max_amount >= amount on every bid row",
        );
      }

      // The highest submitted max_amount (2400) should be the one holding the lead,
      // since it strictly beats every other bidder's max.
      const winner = bidders[bidderCount - 1]!;
      assert.equal(highBid!.bidder_id, winner.id);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });
});

// db/013: a bidder can place a max bid before the auction's own starts_at,
// same Case A-E resolution as a live bid. No lower time bound at all for
// 'scheduled' — that's the point — the ends_at upper bound and every other
// guard (bid_limit, own_organization, bidding_disabled) still apply exactly
// as they do once live.
describe("place_bid — pre-bidding on a scheduled auction", () => {
  async function scheduledAuction(startingPrice = 1000) {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id, {
      startingPrice,
      startsAt: new Date(Date.now() + 60 * 60_000),
      endsAt: new Date(Date.now() + 25 * 60 * 60_000),
    });
    await client.query("update auctions set status = 'scheduled' where id = $1", [auction.id]);
    return { owner, vehicle, auction };
  }

  test("accepts a pre-bid and resolves it exactly like a live Case A bid", async () => {
    const { auction } = await scheduledAuction(1000);
    const bidder = await createUser(client);

    const result = await placeBid(client, auction.id, bidder.id, 1500);
    assert.equal(Number(result.amount), 1000);
    assert.equal(Number(result.max_amount), 1500);

    const updated = await getAuction(client, auction.id);
    assert.equal(updated.status, "scheduled");
    assert.equal(Number(updated.current_price), 1000);
    assert.equal(updated.high_bid_id, result.id);
  });

  test("two pre-bidders resolve via the same proxy logic as live bidding (Case C)", async () => {
    const { auction } = await scheduledAuction(1000);
    const first = await createUser(client);
    const second = await createUser(client);

    await placeBid(client, auction.id, first.id, 1200);
    const winning = await placeBid(client, auction.id, second.id, 1500);

    const updated = await getAuction(client, auction.id);
    assert.equal(updated.high_bid_id, winning.id);
    // second's max (1500) beats first's max (1200) by more than one
    // increment, so second leads at exactly their own bid amount per
    // Case C's least(H.max + increment, new max) — same rule a live
    // Case C bid follows.
    assert.equal(Number(updated.current_price), Number(winning.amount));
  });

  test("still enforces bid_limit_exceeded on a pre-bid", async () => {
    const { auction } = await scheduledAuction(1000);
    const bidder = await createUser(client, { bidLimit: 1200 });

    await assert.rejects(
      () => placeBid(client, auction.id, bidder.id, 1500),
      (err: PgError) => err.message === "bid_limit_exceeded",
    );
  });

  test("still rejects a pre-bid past the auction's own ends_at", async () => {
    const owner = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, owner.id);
    const auction = await createAuction(client, vehicle.id, owner.id, {
      startsAt: new Date(Date.now() - 2000),
      endsAt: new Date(Date.now() - 1000),
    });
    await client.query("update auctions set status = 'scheduled' where id = $1", [auction.id]);
    const bidder = await createUser(client);

    await assert.rejects(
      () => placeBid(client, auction.id, bidder.id, 1000),
      (err: PgError) => err.message === "auction_not_live",
    );
  });
});
