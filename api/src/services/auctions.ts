import type { Pool } from "pg";
import * as auctionsRepo from "../repositories/auctions.ts";
import * as vehiclesRepo from "../repositories/vehicles.ts";
import * as auctionEventsRepo from "../repositories/auctionEvents.ts";
import { ApiError, Errors } from "../errors.ts";
import type { Actor } from "../types.ts";

const KNOWN_BUY_NOW_ERRORS = new Set([
  "auction_not_live",
  "account_inactive",
  "bidding_disabled",
  "own_organization",
  "buy_now_not_available",
  "buy_now_already_bid",
  "bid_limit_exceeded",
]);

const KNOWN_VOID_ERRORS = new Set(["auction_not_live", "bid_not_voidable"]);

interface PgErrorLike {
  message: string;
}

function isPgErrorLike(err: unknown): err is PgErrorLike {
  return typeof err === "object" && err !== null && "message" in err;
}

function requireTeam(actor: Actor | null) {
  if (!actor) throw Errors.unauthenticated();
  if (actor.role !== "team") throw Errors.forbidden();
}

export interface CreateAuctionInput {
  vehicleId: string;
  startingPrice: number;
  reservePrice: number;
  startsAt: string;
  endsAt: string;
  gelRate?: number;
  buyNowPrice?: number;
}

// §1: every phase 1 auction carries a reserve at least at the listing
// (starting) price — this mirrors the `auctions_phase1_reserve_required`
// and `auctions_reserve` DB constraints with a structured error instead of
// a raw constraint-violation message.
export async function create(pool: Pool, actor: Actor | null, input: CreateAuctionInput) {
  requireTeam(actor);

  const vehicle = await vehiclesRepo.findById(pool, input.vehicleId);
  if (!vehicle) throw Errors.notFound("vehicle");
  if (vehicle.status !== "approved") {
    throw new ApiError(400, "vehicle_not_approved");
  }

  // Same class of bug as bidding.ts and admin.ts: NaN/Infinity pass a
  // plain `<` comparison undetected and Postgres numeric would happily
  // store them, corrupting the one thing this system can't get wrong —
  // the price. Team-only endpoint, so lower severity than the bid one,
  // but still worth closing off.
  if (
    !Number.isFinite(input.startingPrice) ||
    !Number.isFinite(input.reservePrice) ||
    input.startingPrice <= 0
  ) {
    throw new ApiError(400, "invalid_price");
  }
  if (input.reservePrice < input.startingPrice) {
    throw new ApiError(400, "reserve_below_starting_price");
  }

  // Buy It Now — decided: must be >= reserve_price (the phase-1 rule that
  // a car never sells for less than listing price applies whether the
  // sale happens via auction or instant buy), mirrored here with a clean
  // error rather than relying solely on auctions_buy_now_reserve.
  if (input.buyNowPrice !== undefined) {
    if (!Number.isFinite(input.buyNowPrice) || input.buyNowPrice <= 0) {
      throw new ApiError(400, "invalid_price");
    }
    if (input.buyNowPrice < input.reservePrice) {
      throw new ApiError(400, "buy_now_below_reserve");
    }
  }

  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  if (!(endsAt > startsAt)) {
    throw new ApiError(400, "invalid_auction_window");
  }

  return auctionsRepo.insert(pool, {
    vehicleId: input.vehicleId,
    createdBy: actor!.id,
    startingPrice: input.startingPrice.toFixed(2),
    reservePrice: input.reservePrice.toFixed(2),
    startsAt,
    endsAt,
    gelRate: input.gelRate?.toFixed(4),
    buyNowPrice: input.buyNowPrice?.toFixed(2),
  });
}

// §6: "Not shown to bidders; the listing shows only whether the reserve
// has been met." reserve_price itself must never reach a non-team caller —
// this was leaking it verbatim until now.
//
// nextMinimumBid is not sensitive (same as buy_now_price) — it's shown to
// everyone so a "Quick Bid" button can display the exact number the bid
// function itself would require, with zero risk of a client-side copy of
// the increment table drifting out of sync.
async function present(pool: Pool, auction: auctionsRepo.Auction, actor: Actor | null) {
  const [nextMinimumBid, bidIncrement] = await Promise.all([
    auctionsRepo.nextMinimumBid(pool, auction),
    auctionsRepo.bidIncrementFor(pool, auction),
  ]);
  if (actor?.role === "team") {
    return { ...auction, nextMinimumBid, bidIncrement };
  }
  const { reserve_price, ...rest } = auction;
  const reserveMet =
    reserve_price === null || Number(auction.current_price) >= Number(reserve_price);
  return { ...rest, reserveMet, nextMinimumBid, bidIncrement };
}

export async function getById(pool: Pool, actor: Actor | null, id: string) {
  const auction = await auctionsRepo.findById(pool, id);
  if (!auction) throw Errors.notFound("auction");
  return present(pool, auction, actor);
}

export async function list(pool: Pool, actor: Actor | null, filters: auctionsRepo.ListFilters) {
  const auctions = await auctionsRepo.list(pool, filters);
  return Promise.all(auctions.map((a) => present(pool, a, actor)));
}

// BACKEND_SPEC.md §12: max_amount is bidder-only, ip_address/user_agent
// are team-only. See auctionsRepo.listBids for the column-level redaction.
export async function listBids(pool: Pool, actor: Actor | null, auctionId: string) {
  return auctionsRepo.listBids(pool, auctionId, actor?.id ?? null, actor?.role === "team");
}

export async function cancel(pool: Pool, actor: Actor | null, auctionId: string) {
  requireTeam(actor);
  const auction = await auctionsRepo.cancel(pool, auctionId, actor!.id);
  if (!auction) throw new ApiError(409, "cannot_cancel");
  return auction;
}

// Team-only. Erases the most recent bid on a live auction (soft-delete —
// see db/010_void_last_bid.sql) and recomputes current_price/high_bid_id
// from whatever's left; the bidder re-bids fresh rather than having the
// mistaken amount corrected in place. Only covers a genuinely new bid
// (Case A/C/D) — a mistaken ceiling raise (Case B) isn't voidable yet.
export async function voidLastBid(pool: Pool, actor: Actor | null, auctionId: string) {
  requireTeam(actor);
  try {
    return await auctionsRepo.voidLastBid(pool, auctionId, actor!.id);
  } catch (err) {
    if (isPgErrorLike(err) && KNOWN_VOID_ERRORS.has(err.message)) {
      throw new ApiError(400, err.message);
    }
    throw err;
  }
}

// Team-only: the recorded history of cancellations/reassignments for an
// auction. See db/009_auction_events.sql for why this exists — reassignSale
// and cancel used to overwrite state with no record of the change.
export async function listEvents(pool: Pool, actor: Actor | null, auctionId: string) {
  requireTeam(actor);
  return auctionEventsRepo.listByAuction(pool, auctionId);
}

// §6: in phase 1 the seller on the pending_seller path is always team.
export async function acceptAsIs(pool: Pool, actor: Actor | null, auctionId: string) {
  requireTeam(actor);
  const auction = await auctionsRepo.acceptAsIs(pool, auctionId);
  if (!auction) throw new ApiError(409, "not_pending_seller");
  return auction;
}

export async function decline(pool: Pool, actor: Actor | null, auctionId: string) {
  requireTeam(actor);
  const auction = await auctionsRepo.decline(pool, auctionId);
  if (!auction) throw new ApiError(409, "not_pending_seller");
  return auction;
}

// §7: manual post-sale reassignment to the underbidder when the winner
// doesn't pay within the confirmed 48-hour deadline.
export async function reassignSale(
  pool: Pool,
  actor: Actor | null,
  auctionId: string,
  newSoldTo: string,
) {
  requireTeam(actor);
  const auction = await auctionsRepo.reassignSale(pool, auctionId, newSoldTo, actor!.id);
  if (!auction) {
    throw new ApiError(409, "cannot_reassign", {
      reason: "auction is not sold, or the given user has no bid on this auction",
    });
  }
  return auction;
}

// Buy It Now: a fixed price that closes the auction instantly. Disappears
// after the first real bid (enforced in buy_now() itself); team and the
// vehicle's own organization are blocked same as ordinary bidding.
export async function buyNow(
  pool: Pool,
  actor: Actor | null,
  auctionId: string,
  requestMeta: { ipAddress?: string | null; userAgent?: string | null } = {},
) {
  if (!actor) throw Errors.unauthenticated();

  try {
    return await auctionsRepo.buyNow(
      pool,
      auctionId,
      actor.id,
      requestMeta.ipAddress ?? null,
      requestMeta.userAgent ?? null,
    );
  } catch (err) {
    if (isPgErrorLike(err) && KNOWN_BUY_NOW_ERRORS.has(err.message)) {
      throw new ApiError(400, err.message);
    }
    throw err;
  }
}
