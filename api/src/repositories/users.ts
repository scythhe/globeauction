import type { Pool } from "pg";

export type UserRole = "team" | "dealer" | "buyer";

export interface User {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  full_name: string;
  phone: string | null;
  organization_id: string | null;
  phone_verified: boolean;
  id_document_number: string | null;
  deposit_amount: string | null;
  deposit_received_at: Date | null;
  can_bid: boolean;
  bid_limit: string | null;
  bid_enabled_by: string | null;
  bid_enabled_at: Date | null;
  is_active: boolean;
}

export async function findByEmail(pool: Pool, email: string): Promise<User | null> {
  const { rows } = await pool.query<User>("select * from users where email = $1", [email]);
  return rows[0] ?? null;
}

export async function findById(pool: Pool, id: string): Promise<User | null> {
  const { rows } = await pool.query<User>("select * from users where id = $1", [id]);
  return rows[0] ?? null;
}

export async function insertBuyer(
  pool: Pool,
  input: { email: string; passwordHash: string; fullName: string; phone: string | null },
): Promise<User> {
  const { rows } = await pool.query<User>(
    `insert into users (email, password_hash, role, full_name, phone)
     values ($1, $2, 'buyer', $3, $4)
     returning *`,
    [input.email, input.passwordHash, input.fullName, input.phone],
  );
  return rows[0]!;
}

export async function recordDeposit(
  pool: Pool,
  userId: string,
  amount: string,
): Promise<User | null> {
  const { rows } = await pool.query<User>(
    `update users
       set deposit_amount = $2,
           deposit_received_at = now(),
           bid_limit = $2::numeric * 10
     where id = $1
     returning *`,
    [userId, amount],
  );
  return rows[0] ?? null;
}

export async function enableBidding(
  pool: Pool,
  userId: string,
  enabledBy: string,
): Promise<User | null> {
  const { rows } = await pool.query<User>(
    `update users
       set can_bid = true,
           bid_enabled_by = $2,
           bid_enabled_at = now()
     where id = $1
     returning *`,
    [userId, enabledBy],
  );
  return rows[0] ?? null;
}

export async function listUnvetted(pool: Pool): Promise<User[]> {
  const { rows } = await pool.query<User>(
    "select * from users where can_bid = false and role in ('dealer', 'buyer') order by created_at asc",
  );
  return rows;
}
