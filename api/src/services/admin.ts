import type { Pool } from "pg";
import * as usersRepo from "../repositories/users.ts";
import { ApiError, Errors } from "../errors.ts";
import type { Actor } from "../types.ts";

const MINIMUM_DEPOSIT_GEL = 500;

function requireTeam(actor: Actor | null) {
  if (!actor) throw Errors.unauthenticated();
  if (actor.role !== "team") throw Errors.forbidden();
}

// Team-facing view of a user: everything vetting-relevant, but never
// password_hash — that must never leave the server, team-facing or not.
function toTeamUser(user: usersRepo.User) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    fullName: user.full_name,
    phone: user.phone,
    organizationId: user.organization_id,
    phoneVerified: user.phone_verified,
    depositAmount: user.deposit_amount,
    depositReceivedAt: user.deposit_received_at,
    canBid: user.can_bid,
    bidLimit: user.bid_limit,
    bidEnabledBy: user.bid_enabled_by,
    bidEnabledAt: user.bid_enabled_at,
    isActive: user.is_active,
  };
}

// §2.1: 500 GEL deposit, recorded by team after a bank transfer. This is
// step one of the two-step gate — recording the deposit does not itself
// enable bidding, see enableBidding below.
export async function recordDeposit(
  pool: Pool,
  actor: Actor | null,
  userId: string,
  amountGel: number,
) {
  requireTeam(actor);

  // `NaN < 500` is false in JS — a non-numeric amount (e.g. the literal
  // string "NaN", which Number() parses without error) silently sailed
  // past this check before Number.isFinite was added here. Confirmed live:
  // it set deposit_received_at with deposit_amount "NaN" and then
  // enable-bidding's own `< MINIMUM_DEPOSIT_GEL` check let it through too,
  // for the same reason.
  if (!Number.isFinite(amountGel) || amountGel < MINIMUM_DEPOSIT_GEL) {
    throw new ApiError(400, "deposit_below_minimum", { minimum: MINIMUM_DEPOSIT_GEL });
  }

  const user = await usersRepo.recordDeposit(pool, userId, amountGel.toFixed(2));
  if (!user) throw Errors.notFound("user");
  return toTeamUser(user);
}

// §2.1: "team doesn't flip can_bid until deposit_received_at is set" —
// enforced here, not just left to the team member's judgment in the UI.
export async function enableBidding(pool: Pool, actor: Actor | null, userId: string) {
  requireTeam(actor);

  const user = await usersRepo.findById(pool, userId);
  if (!user) throw Errors.notFound("user");

  if (!user.deposit_received_at) {
    throw new ApiError(400, "deposit_required");
  }
  const depositAmount = Number(user.deposit_amount ?? 0);
  if (!Number.isFinite(depositAmount) || depositAmount < MINIMUM_DEPOSIT_GEL) {
    throw new ApiError(400, "deposit_below_minimum", { minimum: MINIMUM_DEPOSIT_GEL });
  }

  const updated = await usersRepo.enableBidding(pool, userId, actor!.id);
  if (!updated) throw Errors.notFound("user");
  return toTeamUser(updated);
}

export async function listUnvetted(pool: Pool, actor: Actor | null) {
  requireTeam(actor);
  const users = await usersRepo.listUnvetted(pool);
  return users.map(toTeamUser);
}
