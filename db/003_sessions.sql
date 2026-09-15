-- 003_sessions.sql
-- DB-backed session tokens. The bearer token itself is never stored — only
-- a sha256 hash of it — so a DB leak doesn't hand out usable tokens.
-- Revocation is a plain UPDATE (revoked_at), which is the whole reason this
-- was chosen over JWT: team can cut off a compromised or banned account
-- immediately, not just at token expiry.

create table sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id),
  token_hash  text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);

create index sessions_user_idx on sessions (user_id);

-- Fast "is this token currently valid" lookups.
create index sessions_valid_idx on sessions (token_hash)
  where revoked_at is null;
