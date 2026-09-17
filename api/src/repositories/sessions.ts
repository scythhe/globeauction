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

// `revoked_at` existed on the schema and was checked on every read, but
// nothing ever set it — sessions were only ever DB-backed for instant
// revocability in name; "log out" was a client-side-only token discard,
// so a leaked/stolen token stayed valid until its natural expiry no
// matter what. This is what "instant revocability" actually requires.
export async function revoke(pool: Pool, tokenHash: string): Promise<void> {
  await pool.query(
    "update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null",
    [tokenHash],
  );
}
