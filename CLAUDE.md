# Glob Auction — project context

Internal online car auction for Global Auto Import (glob.ge / globmarket.ge), Tbilisi.
Standalone system. No live dependency on the existing company website.

Read `docs/BACKEND_SPEC.md` before making design decisions. It is the source of
truth for auction rules, state machines, and the bidding algorithm. If something
here conflicts with the spec, the spec wins — and tell me about the conflict.

## Phase 1 (~3 months)

Company-owned inventory only. One lot per week, closing Friday. No dealer
submissions yet. Every lot carries a mandatory reserve at the normal listing
price, enforced by a database constraint, so an auction can never sell a car
below what the company would have accepted anyway.

Roles `dealer` and the `counteroffers` table exist in the schema but are unused
in phase 1. Don't delete them; don't build UI for them either.

## Stack

- API: Node + TypeScript
- DB: Postgres 16 (local via Docker during development)
- Frontend: React + TypeScript
- Photos: S3-compatible object storage (Cloudflare R2), presigned uploads
- No ORM. Plain SQL in a repository layer.

## Layout

```
/api          Node + TypeScript API
/web          React frontend
/db           numbered SQL migrations
/docs         BACKEND_SPEC.md
```

## API structure

Three layers, strictly:

- `routes/` — HTTP, request validation, auth check. No business logic.
- `services/` — the rules. One file per domain area.
- `repositories/` — SQL. Nothing else touches the database.

Exception: bidding. The bid resolution runs as a Postgres function, called from
one service method. That function is the only path by which a bid row is created.

## Hard rules

1. **All money is `numeric`.** Never a JS `number`, never floating point. Price
   arithmetic happens in SQL or with a decimal library. GEL is the working
   currency — every price column holds a GEL figure. USD is a display-only
   conversion from GEL at `auctions.gel_rate`, computed at render time, never
   stored, never compared against. (Revised from the original direction —
   see BACKEND_SPEC.md §10.)
2. **Bids are written only by the Postgres bid function**, inside a transaction
   that opens with `SELECT ... FROM auctions WHERE id = $1 FOR UPDATE`. Never
   read a price in one request and write a bid based on it in another.
3. **`bids.max_amount` is never returned to anyone other than the bidder who
   set it** — nobody else, team included. **`ip_address` and `user_agent` are
   team-only** instead — visible to team on every row, hidden from everyone
   else. Two separate rules, not one: max_amount is stricter (bidder-only),
   ip/user_agent is looser (team-only).
4. **Authorization checks live in the service layer**, not only in route
   middleware. A route that forgets its middleware must still fail.
5. **Nobody bids on their own organization's cars.** Check `organization_id`,
   not just `owner_id`. `team` accounts cannot bid at all.
6. **Schema changes go in a new numbered migration** in `/db`. Never edit an
   applied migration, never change the schema through a GUI.
7. **Three languages**: Georgian, English, Russian. No hardcoded user-facing
   strings — everything through the i18n layer from the start. Done — a
   custom layer at `web/src/i18n/` (dictionary + context, no dependency),
   Georgian-first with an English/Russian switcher. New user-facing text
   goes through `t()`/the translation dictionary, not a literal string.

## Conventions

- Errors return a structured code plus the data the UI needs, e.g.
  `{ "error": "bid_too_low", "minimum": 12500, "current_price": 12400 }`.
  Not a bare message string.
- Times are `timestamptz`, always UTC in the database.
- Env config via `.env`, never committed. `.env.example` is committed.
- Passwords: argon2id.

## Working with me

- Ask before adding a dependency.
- Don't add features that aren't in the spec. If you think something is missing,
  say so rather than building it.
- When touching the bid function, write the test first. Cases A–E in the spec,
  plus a concurrency test with parallel inserts.
- I'm a student and this is my first system of this size at work. Explain
  non-obvious decisions rather than just doing them, and push back if I ask for
  something that will cause problems later.
