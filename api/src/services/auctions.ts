import type { Pool } from "pg";
import * as auctionsRepo from "../repositories/auctions.ts";
import * as vehiclesRepo from "../repositories/vehicles.ts";
import { ApiError, Errors } from "../errors.ts";
import type { Actor } from "../types.ts";

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
  });
}

// §6: "Not shown to bidders; the listing shows only whether the reserve
// has been met." reserve_price itself must never reach a non-team caller —
// this was leaking it verbatim until now.
function toPublicAuction(auction: auctionsRepo.Auction) {
  const { reserve_price, ...rest } = auction;
  const reserveMet =
    reserve_price === null || Number(auction.current_price) >= Number(reserve_price);
  return { ...rest, reserveMet };
}

function present(auction: auctionsRepo.Auction, actor: Actor | null) {
  return actor?.role === "team" ? auction : toPublicAuction(auction);
}

export async function getById(pool: Pool, actor: Actor | null, id: string) {
  const auction = await auctionsRepo.findById(pool, id);
  if (!auction) throw Errors.notFound("auction");
  return present(auction, actor);
}

export async function list(pool: Pool, actor: Actor | null, filters: auctionsRepo.ListFilters) {
  const auctions = await auctionsRepo.list(pool, filters);
  return auctions.map((a) => present(a, actor));
}

// CLAUDE.md rule 3: max_amount / ip_address / user_agent are team-only.
export async function listBids(pool: Pool, actor: Actor | null, auctionId: string) {
  if (actor?.role === "team") {
    return auctionsRepo.listBidsFull(pool, auctionId);
  }
  return auctionsRepo.listBidsPublic(pool, auctionId);
}

export async function cancel(pool: Pool, actor: Actor | null, auctionId: string) {
  requireTeam(actor);
  const auction = await auctionsRepo.cancel(pool, auctionId);
  if (!auction) throw new ApiError(409, "cannot_cancel");
  return auction;
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
  const auction = await auctionsRepo.reassignSale(pool, auctionId, newSoldTo);
  if (!auction) {
    throw new ApiError(409, "cannot_reassign", {
      reason: "auction is not sold, or the given user has no bid on this auction",
    });
  }
  return auction;
}
