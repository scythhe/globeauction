import type { Pool } from "pg";
import * as auctionsRepo from "../repositories/auctions.ts";
import { runNotificationSweep } from "../notifications/service.ts";
import { consoleMailer, type Mailer } from "../notifications/mailer.ts";

// §8: one process on the API server, running every 30 seconds. Each
// underlying query uses FOR UPDATE SKIP LOCKED so a second instance of
// this job (e.g. two API processes) doesn't double-process a row.
export async function runOnce(pool: Pool, mailer: Mailer = consoleMailer): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const opened = await auctionsRepo.openScheduledAuctions(client);
    await client.query("commit");
    if (opened > 0) console.log(`jobs: opened ${opened} scheduled auction(s)`);
  } catch (err) {
    await client.query("rollback");
    console.error("jobs: open-scheduled failed", err);
  } finally {
    client.release();
  }

  const closeClient = await pool.connect();
  try {
    await closeClient.query("begin");
    const closed = await auctionsRepo.closeExpiredAuctions(closeClient);
    await closeClient.query("commit");
    for (const c of closed) console.log(`jobs: auction ${c.id} closed -> ${c.outcome}`);
  } catch (err) {
    await closeClient.query("rollback");
    console.error("jobs: close-expired failed", err);
  } finally {
    closeClient.release();
  }

  const expireClient = await pool.connect();
  try {
    await expireClient.query("begin");
    const expired = await auctionsRepo.expireSellerDecisions(expireClient);
    await expireClient.query("commit");
    if (expired > 0) console.log(`jobs: expired ${expired} seller decision(s) -> unsold`);
  } catch (err) {
    await expireClient.query("rollback");
    console.error("jobs: expire-seller-decisions failed", err);
  } finally {
    expireClient.release();
  }

  // §9: outbid / ending-soon / reserve-not-met. Runs after the status
  // transitions above so a just-closed auction's reserve_not_met notice
  // can fire in the same tick. "Won" is deliberately not sent — the team
  // contacts winners directly per §7's payment process.
  try {
    await runNotificationSweep(pool, mailer);
  } catch (err) {
    console.error("jobs: notification sweep failed", err);
  }
}

export function startJobLoop(
  pool: Pool,
  intervalMs = 30_000,
  mailer: Mailer = consoleMailer,
): () => void {
  const timer = setInterval(() => {
    runOnce(pool, mailer).catch((err) => console.error("jobs: unexpected error", err));
  }, intervalMs);
  return () => clearInterval(timer);
}
