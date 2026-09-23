import type { Pool } from "pg";

export interface Vehicle {
  id: string;
  owner_id: string;
  status: "draft" | "pending" | "approved" | "rejected";
  vin: string | null;
  make: string;
  model: string;
  year: number;
  body_style: string | null;
  color: string | null;
  mileage: number | null;
  mileage_unit: string;
  location: string | null;
  description: string | null;
}

export interface NewVehicleInput {
  ownerId: string;
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

// Phase 1 only: team creates vehicles directly in 'approved', skipping the
// draft/pending/submit flow entirely. BACKEND_SPEC.md §3.
export async function insertApproved(pool: Pool, input: NewVehicleInput): Promise<Vehicle> {
  const { rows } = await pool.query<Vehicle>(
    `insert into vehicles
       (owner_id, status, vin, make, model, year, body_style, color,
        mileage, mileage_unit, location, description)
     values ($1, 'approved', $2, $3, $4, $5, $6, $7, $8, coalesce($9, 'km'), $10, $11)
     returning *`,
    [
      input.ownerId,
      input.vin ?? null,
      input.make,
      input.model,
      input.year,
      input.bodyStyle ?? null,
      input.color ?? null,
      input.mileage ?? null,
      input.mileageUnit ?? null,
      input.location ?? null,
      input.description ?? null,
    ],
  );
  return rows[0]!;
}

export async function findById(pool: Pool, id: string): Promise<Vehicle | null> {
  const { rows } = await pool.query<Vehicle>("select * from vehicles where id = $1", [id]);
  return rows[0] ?? null;
}

// Vehicles a new auction could actually be created for right now: approved,
// and not already carrying an open auction — the same status set
// `auctions_one_open_per_vehicle` (db/001_init.sql) enforces, mirrored here
// so the team panel's picker only ever offers something auctions.create()
// would accept, instead of a free-text vehicle ID a team member has to get
// right by memory or copy-paste.
export async function listAvailableForAuction(pool: Pool): Promise<Vehicle[]> {
  const { rows } = await pool.query<Vehicle>(
    `select v.* from vehicles v
      where v.status = 'approved'
        and not exists (
          select 1 from auctions a
           where a.vehicle_id = v.id
             and a.status in ('scheduled', 'live', 'pending_seller', 'counter_offered')
        )
      order by v.created_at desc`,
  );
  return rows;
}
