import type { Pool } from "pg";

export interface VehiclePhoto {
  id: string;
  vehicle_id: string;
  url: string;
  sort_order: number;
  created_at: Date;
}

export async function count(pool: Pool, vehicleId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    "select count(*) from vehicle_photos where vehicle_id = $1",
    [vehicleId],
  );
  return Number(rows[0]!.count);
}

export async function nextSortOrder(pool: Pool, vehicleId: string): Promise<number> {
  const { rows } = await pool.query<{ next: number }>(
    "select coalesce(max(sort_order), -1) + 1 as next from vehicle_photos where vehicle_id = $1",
    [vehicleId],
  );
  return rows[0]!.next;
}

export async function insert(
  pool: Pool,
  vehicleId: string,
  url: string,
  sortOrder: number,
): Promise<VehiclePhoto> {
  const { rows } = await pool.query<VehiclePhoto>(
    `insert into vehicle_photos (vehicle_id, url, sort_order)
     values ($1, $2, $3)
     returning *`,
    [vehicleId, url, sortOrder],
  );
  return rows[0]!;
}

export async function listByVehicle(pool: Pool, vehicleId: string): Promise<VehiclePhoto[]> {
  const { rows } = await pool.query<VehiclePhoto>(
    "select * from vehicle_photos where vehicle_id = $1 order by sort_order asc",
    [vehicleId],
  );
  return rows;
}

export async function findById(pool: Pool, id: string): Promise<VehiclePhoto | null> {
  const { rows } = await pool.query<VehiclePhoto>("select * from vehicle_photos where id = $1", [
    id,
  ]);
  return rows[0] ?? null;
}

export async function remove(pool: Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query("delete from vehicle_photos where id = $1", [id]);
  return (rowCount ?? 0) > 0;
}
