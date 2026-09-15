# globeauction-api

## Setup

```bash
npm install
cp .env.example .env   # then edit DATABASE_URL / TEST_DATABASE_URL if needed
npm run migrate        # applies db/*.sql against DATABASE_URL
```

For tests, apply migrations to the test database too:

```bash
DATABASE_URL="$TEST_DATABASE_URL" npm run migrate
npm test
```

## Local Postgres

Either:

- `docker compose up -d` (repo root) — Postgres 16, matches `.env.example` once
  you point `DATABASE_URL`/`TEST_DATABASE_URL` at `localhost:5432` with the
  `globeauction`/`globeauction` credentials from `docker-compose.yml`, or
- a local install (`brew install postgresql@16`, `brew services start postgresql@16`),
  with `globeauction_dev` / `globeauction_test` databases created.

## Layout

See root `CLAUDE.md` for the three-layer rule (`routes/` → `services/` →
`repositories/`) and the bidding exception: `db/002_bid_function.sql`'s
`place_bid()` is the only path that writes to `bids`.
