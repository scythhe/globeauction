import type { Pool, PoolClient } from "pg";
import * as notificationsRepo from "../repositories/notifications.ts";
import type { Mailer } from "./mailer.ts";

const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

// Each notification gets its own transaction, on one connection throughout:
// log (claims the dedup slot via the partial unique index) -> send -> mark
// sent -> commit. If two job ticks somehow race on the same event, the
// loser hits a unique-violation on insert — expected, and simply skipped
// rather than crashing the whole sweep. If sending itself fails, the
// insert rolls back entirely (no half-logged row), and the next tick's
// `not exists` check picks the candidate up again. Per §9, "a failing mail
// server must never roll back a bid" — this doesn't touch the bid
// transaction at all, it runs entirely separately from it.
async function runOne(
  pool: Pool,
  label: string,
  attempt: (client: PoolClient) => Promise<void>,
): Promise<"sent" | "skipped" | "failed"> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await attempt(client);
    await client.query("commit");
    return "sent";
  } catch (err) {
    await client.query("rollback").catch(() => {});
    if (isUniqueViolation(err)) {
      return "skipped";
    }
    console.error(`notifications: ${label} failed`, err);
    return "failed";
  } finally {
    client.release();
  }
}

export async function runNotificationSweep(pool: Pool, mailer: Mailer): Promise<void> {
  await sweepOutbid(pool, mailer);
  await sweepEndingSoon(pool, mailer);
  await sweepReserveNotMet(pool, mailer);
}

async function sweepOutbid(pool: Pool, mailer: Mailer): Promise<void> {
  const readClient = await pool.connect();
  let candidates;
  try {
    candidates = await notificationsRepo.findUnnotifiedOutbids(readClient);
  } finally {
    readClient.release();
  }

  for (const c of candidates) {
    await runOne(pool, `outbid(${c.bid_id})`, async (client) => {
      const id = await notificationsRepo.logPending(client, "outbid", c.bidder_id, c.auction_id, c.bid_id);
      await mailer({
        to: c.email,
        subject: "You've been outbid",
        body: `Hi ${c.full_name},\n\nSomeone has outbid you on a lot you're watching. Log in to raise your maximum if you'd like to stay in it.`,
      });
      await notificationsRepo.markSent(client, id);
    });
  }
}

async function sweepEndingSoon(pool: Pool, mailer: Mailer): Promise<void> {
  const readClient = await pool.connect();
  let candidates;
  try {
    candidates = await notificationsRepo.findUnnotifiedEndingSoon(readClient);
  } finally {
    readClient.release();
  }

  for (const c of candidates) {
    await runOne(pool, `ending_soon(${c.auction_id},${c.bidder_id})`, async (client) => {
      const id = await notificationsRepo.logPending(client, "ending_soon", c.bidder_id, c.auction_id);
      await mailer({
        to: c.email,
        subject: "Auction ending soon",
        body: `Hi ${c.full_name},\n\nA lot you've bid on closes within the hour (${c.ends_at.toISOString()}). Log in if you'd like to check your position.`,
      });
      await notificationsRepo.markSent(client, id);
    });
  }
}

async function sweepReserveNotMet(pool: Pool, mailer: Mailer): Promise<void> {
  const readClient = await pool.connect();
  let candidates;
  try {
    candidates = await notificationsRepo.findUnnotifiedReserveNotMet(readClient);
  } finally {
    readClient.release();
  }

  for (const c of candidates) {
    await runOne(pool, `reserve_not_met(${c.auction_id})`, async (client) => {
      const id = await notificationsRepo.logPending(client, "reserve_not_met", c.seller_id, c.auction_id);
      await mailer({
        to: c.email,
        subject: "Reserve not met",
        body: `Hi ${c.full_name},\n\nAn auction closed at ${c.current_price} ₾, below the ${c.reserve_price} ₾ reserve. Accept, decline, or counter from the admin panel.`,
      });
      await notificationsRepo.markSent(client, id);
    });
  }
}
