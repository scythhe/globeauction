import type { Pool } from "pg";
import * as vehiclesRepo from "../repositories/vehicles.ts";
import { Errors } from "../errors.ts";
import type { Actor } from "../types.ts";

export interface CreateVehicleInput {
  make: string;
  model: string;
  year: number;
  vin?: string;
  bodyStyle?: string;
  color?: string;
  mileage?: number;
  mileageUnit?: string;
  location?: string;
  description?: string;
}

// Phase 1 only: team creates a vehicle directly in 'approved'. There is no
// dealer submission flow yet (BACKEND_SPEC.md §1, §3) — this deliberately
// does not accept a dealer actor at all, not even in draft.
export async function create(pool: Pool, actor: Actor | null, input: CreateVehicleInput) {
  if (!actor) throw Errors.unauthenticated();
  if (actor.role !== "team") throw Errors.forbidden();

  if (!input.make || !input.model || !input.year) {
    throw Errors.validation("make, model, and year are required");
  }
  // Mirrors the DB's own vehicles_year_sane / vehicles_mileage_sane
  // constraints with a clean error instead of an unhandled constraint
  // violation. Confirmed live: year: 99999 previously crashed with a raw
  // 500 instead of a validation error.
  if (!Number.isInteger(input.year) || input.year < 1900 || input.year > 2100) {
    throw Errors.validation("year must be an integer between 1900 and 2100");
  }
  if (input.mileage !== undefined && (!Number.isFinite(input.mileage) || input.mileage < 0)) {
    throw Errors.validation("mileage must be a finite non-negative number");
  }

  return vehiclesRepo.insertApproved(pool, {
    ownerId: actor.id,
    make: input.make,
    model: input.model,
    year: input.year,
    vin: input.vin,
    bodyStyle: input.bodyStyle,
    color: input.color,
    mileage: input.mileage,
    mileageUnit: input.mileageUnit,
    location: input.location,
    description: input.description,
  });
}

export async function getById(pool: Pool, id: string) {
  const vehicle = await vehiclesRepo.findById(pool, id);
  if (!vehicle) throw Errors.notFound("vehicle");
  return vehicle;
}
