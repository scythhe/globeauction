import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Client, Pool } from "pg";
import { runNotificationSweep } from "../src/notifications/service.ts";
import type { Email, Mailer } from "../src/notifications/mailer.ts";
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

function recordingMailer(): { mailer: Mailer; sent: Email[] } {
  const sent: Email[] = [];
  const mailer: Mailer = async (email) => {
    sent.push(email);
  };
  return { mailer, sent };
}

describe("outbid notifications", () => {
  test("notifies the bidder who was just proxied down, exactly once", async () => {
    const team = await createUser(client, { role: "team" });
    const alice = await createUser(client, { email: "alice@example.com", role: "buyer" });
    const bob = await createUser(client, { email: "bob@example.com", role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, {
      startingPrice: 1000,
      endsAt: new Date(Date.now() + 3 * 60 * 60_000), // well outside the ending-soon window
    });

    await placeBid(client, auction.id, alice.id, 1200);
    await placeBid(client, auction.id, bob.id, 2000); // outbids alice, creates a proxy row for her

    const { mailer, sent } = recordingMailer();
    await runNotificationSweep(pool, mailer);

    const aliceEmails = sent.filter((e) => e.to === "alice@example.com");
    assert.equal(aliceEmails.length, 1);
    assert.match(aliceEmails[0]!.subject, /outbid/i);

    // bob is currently winning — he shouldn't get an outbid notice.
    assert.equal(sent.filter((e) => e.to === "bob@example.com").length, 0);
  });

  test("does not re-notify on a second sweep for the same event", async () => {
    const team = await createUser(client, { role: "team" });
    const alice = await createUser(client, { email: "alice2@example.com", role: "buyer" });
    const bob = await createUser(client, { email: "bob2@example.com", role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, {
      startingPrice: 1000,
      endsAt: new Date(Date.now() + 3 * 60 * 60_000), // well outside the ending-soon window
    });
    await placeBid(client, auction.id, alice.id, 1200);
    await placeBid(client, auction.id, bob.id, 2000);

    const { mailer, sent } = recordingMailer();
    await runNotificationSweep(pool, mailer);
    await runNotificationSweep(pool, mailer);
    await runNotificationSweep(pool, mailer);

    assert.equal(sent.filter((e) => e.to === "alice2@example.com").length, 1);
  });

  test("a second outbid event for the same person on the same auction notifies again — different bid, different event", async () => {
    const team = await createUser(client, { role: "team" });
    const alice = await createUser(client, { email: "alice3@example.com", role: "buyer" });
    const bob = await createUser(client, { email: "bob3@example.com", role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, {
      startingPrice: 1000,
      endsAt: new Date(Date.now() + 3 * 60 * 60_000), // well outside the ending-soon window
    });

    await placeBid(client, auction.id, alice.id, 1200);
    await placeBid(client, auction.id, bob.id, 1300); // outbids alice once
    const { mailer, sent } = recordingMailer();
    await runNotificationSweep(pool, mailer);
    assert.equal(sent.filter((e) => e.to === "alice3@example.com").length, 1);

    await placeBid(client, auction.id, alice.id, 5000); // alice retakes the lead
    await placeBid(client, auction.id, bob.id, 5500); // outbids alice again — a new proxy row
    await runNotificationSweep(pool, mailer);
    assert.equal(
      sent.filter((e) => e.to === "alice3@example.com").length,
      2,
      "a genuinely new outbid event must still notify",
    );
  });

  test("if the mailer throws, nothing is marked sent and the next sweep retries", async () => {
    const team = await createUser(client, { role: "team" });
    const alice = await createUser(client, { email: "alice4@example.com", role: "buyer" });
    const bob = await createUser(client, { email: "bob4@example.com", role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, {
      startingPrice: 1000,
      endsAt: new Date(Date.now() + 3 * 60 * 60_000), // well outside the ending-soon window
    });
    await placeBid(client, auction.id, alice.id, 1200);
    await placeBid(client, auction.id, bob.id, 2000);

    const failingMailer: Mailer = async () => {
      throw new Error("mail server down");
    };
    await runNotificationSweep(pool, failingMailer); // swallows the error internally, logs it

    const { rows } = await client.query(
      "select * from notification_log where kind = 'outbid'",
    );
    assert.equal(rows.length, 0, "a failed send must not leave a half-logged row behind");

    // now the mail server is back up — the next sweep should succeed.
    const { mailer, sent } = recordingMailer();
    await runNotificationSweep(pool, mailer);
    assert.equal(sent.filter((e) => e.to === "alice4@example.com").length, 1);
  });
});

describe("ending-soon notifications", () => {
  test("notifies a bidder on an auction closing within the hour", async () => {
    const team = await createUser(client, { role: "team" });
    const bidder = await createUser(client, { email: "soon@example.com", role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, {
      startingPrice: 1000,
      endsAt: new Date(Date.now() + 30 * 60_000),
    });
    await placeBid(client, auction.id, bidder.id, 1200);

    const { mailer, sent } = recordingMailer();
    await runNotificationSweep(pool, mailer);
    assert.equal(sent.filter((e) => e.to === "soon@example.com").length, 1);
  });

  test("does not notify a bidder on an auction closing more than an hour out", async () => {
    const team = await createUser(client, { role: "team" });
    const bidder = await createUser(client, { email: "far@example.com", role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, {
      startingPrice: 1000,
      endsAt: new Date(Date.now() + 3 * 60 * 60_000),
    });
    await placeBid(client, auction.id, bidder.id, 1200);

    const { mailer, sent } = recordingMailer();
    await runNotificationSweep(pool, mailer);
    assert.equal(sent.filter((e) => e.to === "far@example.com").length, 0);
  });

  test("does not re-notify the same bidder on the same auction twice", async () => {
    const team = await createUser(client, { role: "team" });
    const bidder = await createUser(client, { email: "soon2@example.com", role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, {
      startingPrice: 1000,
      endsAt: new Date(Date.now() + 30 * 60_000),
    });
    await placeBid(client, auction.id, bidder.id, 1200);

    const { mailer, sent } = recordingMailer();
    await runNotificationSweep(pool, mailer);
    await runNotificationSweep(pool, mailer);
    assert.equal(sent.filter((e) => e.to === "soon2@example.com").length, 1);
  });
});

describe("reserve-not-met notifications", () => {
  test("notifies the vehicle owner (the phase-1 seller) once an auction lands in pending_seller", async () => {
    const team = await createUser(client, { email: "team-seller@example.com", role: "team" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, {
      startingPrice: 1000,
      reservePrice: 5000,
    });
    await setAuctionStatus(client, auction.id, "pending_seller");

    const { mailer, sent } = recordingMailer();
    await runNotificationSweep(pool, mailer);
    assert.equal(sent.filter((e) => e.to === "team-seller@example.com").length, 1);
  });

  test("does not notify for an auction that's still live", async () => {
    const team = await createUser(client, { email: "team-seller2@example.com", role: "team" });
    const vehicle = await createVehicle(client, team.id);
    await createAuction(client, vehicle.id, team.id, { startingPrice: 1000, reservePrice: 5000 });

    const { mailer, sent } = recordingMailer();
    await runNotificationSweep(pool, mailer);
    assert.equal(sent.filter((e) => e.to === "team-seller2@example.com").length, 0);
  });

  test("does not re-notify on a second sweep", async () => {
    const team = await createUser(client, { email: "team-seller3@example.com", role: "team" });
    const vehicle = await createVehicle(client, team.id);
    const auction = await createAuction(client, vehicle.id, team.id, {
      startingPrice: 1000,
      reservePrice: 5000,
    });
    await setAuctionStatus(client, auction.id, "pending_seller");

    const { mailer, sent } = recordingMailer();
    await runNotificationSweep(pool, mailer);
    await runNotificationSweep(pool, mailer);
    assert.equal(sent.filter((e) => e.to === "team-seller3@example.com").length, 1);
  });
});
