import type { Pool } from "pg";

export interface Session {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

export async function create(
  pool: Pool,
  userId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<Session> {
  const { rows } = await pool.query<Session>(
    `insert into sessions (user_id, token_hash, expires_at)
     values ($1, $2, $3)
     returning *`,
    [userId, tokenHash, expiresAt],
  );
  return rows[0]!;
}

export async function findValidByTokenHash(
  pool: Pool,
  tokenHash: string,
): Promise<Session | null> {
  const { rows } = await pool.query<Session>(
    `select * from sessions
      where token_hash = $1
        and revoked_at is null
        and expires_at > now()`,
    [tokenHash],
  );
  return rows[0] ?? null;
}
