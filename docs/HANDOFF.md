# GlobAuction — Handoff Notes

Engineering handoff for the Global Auto Import auction platform. Written for
whoever picks this up next — a supervisor, a successor engineer, or future
reference. Reflects the actual state of the repository as of 2026-09-25, not
a plan or an intention.

- **Project:** Global Auto Import auction platform (Tbilisi)
- **Phase:** 1 of ~3 (company-owned inventory only, one lot per week)
- **Status:** code-complete for Phase 1's scope, not deployed anywhere
  outside local development

## 1. Snapshot

- 232 / 232 API tests passing
- 14 numbered DB migrations (`/db/001` through `/db/014`)
- 18 commits, all on `main`, all pushed

## 2. What's built and working

**Bidding engine** (`db/002` → `db/014`) — Proxy bidding (Cases A–E) inside
one Postgres function, `place_bid()`, run under a row lock; the only path
that ever writes a bid. Covers bid limits, soft-close extension, one-time
bonus overtime, void-last-bid for a mistyped amount, pre-bidding before an
auction opens, and Monster Bid (a flat, publicly-revealed bid that skips
proxy concealment but still loses to a genuinely higher hidden max).

**Reserve & seller decision** (§6 of `BACKEND_SPEC.md`) — Reserve enforced
by a database constraint (an auction can never list below the standing
price). Accept / decline / counteroffer flow exists in schema and service
layer for when an auction closes under reserve.

**Buy It Now, cancellation, audit trail** (`db/006`, `db/009`) — Instant
purchase before any bid lands; team can cancel/reassign an auction with a
logged event trail.

**Photos** — Presigned uploads to R2, minimum-1-photo guard before an
auction can go live, cover-photo picker.

**Team dashboard** (`TeamPanelPage`) — Vehicle picker, auction wizard,
manage-auctions view.

**i18n** — Georgian, English, Russian. No hardcoded user-facing strings.
Georgian-first with a switcher. All wording verified across all three
languages for fit and correctness, not just translated.

**Bid status UI** (`BidStatusRing`) — Circular winning/outbid/won/lost
indicator, modeled on a Copart reference video. Live-updating price,
countdown, pre-bid entry for scheduled lots.

## 3. Security posture

- `bids.max_amount` — bidder-only, never returned to anyone else, team
  included.
- `ip_address` / `user_agent` — team-only, hidden from other bidders.
- All money as Postgres `numeric` end to end — never a JS float — with a
  validated decimal-string pattern at the API boundary.
- Authorization checked in the service layer, not just route middleware, so
  a route that forgets its middleware still fails closed.
- An organization can never bid on its own listed vehicle — checked by
  `organization_id`, not just `owner_id`.
- Registration's email-enumeration oracle closed; passwords hashed with
  argon2id.
- A self-directed audit pass found and fixed a bid-amount overflow gap (an
  oversized number could reach the DB before `numeric(12,2)` caught it).

## 4. Open items — needs a decision, not code

- **A real payment/handover step.** Phase 1 has no payment module. Someone
  needs to own what happens after an auction closes — collecting money,
  transferring the car — and confirm that's intentionally staying outside
  this system for now.
- **Production hosting.** Everything to date has run on local development
  machines. No domain, server, or deploy pipeline has been set up.
- **First real listing.** Needs an actual vehicle, real photos, and a
  confirmed reserve price before the first live auction can run for real.
- **Buyer/dealer onboarding for launch.** Who gets an account for the
  pilot — a closed group, or open registration from day one?
- **On-call coverage for the Friday close.** Soft-close and bonus-overtime
  logic mean the last minutes of an auction are exactly when something
  would need a human, if anything ever does.

## 5. Local environment & credentials to rotate

Dev-only accounts exist in the local Postgres database for testing. These
were set for local verification during this work and **must be rotated (or
the accounts removed)** before anything here is treated as
production-adjacent:

| Role  | Email                  | Note                                    |
|-------|------------------------|------------------------------------------|
| team  | `team@globmarket.ge`   | Password reset locally for testing — rotate. |
| buyer | `buyer2@example.com`   | Password reset locally for testing — rotate. |

Passwords are argon2id-hashed and not retrievable by design — resetting is
the only option, for these or any other account.

## 6. How to run it locally

```bash
# Postgres 16 running locally; apply migrations in /db in numeric order.

cd api && npm install && npm run migrate
node --env-file=.env src/index.ts   # listens on :3000, routes under /api

cd web && npm install && npm run dev   # Vite, :5173

cd api && npm test   # full suite against a separate globeauction_test database
```

## 7. Migration history

| # | Migration |
|---|-----------|
| 001 | init schema |
| 002 | bid function (`place_bid`) |
| 003 | sessions |
| 004 | bid IP tracking |
| 005 | notification log |
| 006 | Buy It Now |
| 007 | case-B raise-only fix |
| 008 | enforce bid limit |
| 009 | auction events / audit trail |
| 010 | void last bid |
| 011 | split soft-close trigger/extension |
| 012 | one-time bonus overtime |
| 013 | pre-bidding on scheduled auctions |
| 014 | flat bid (Monster Bid reveals its own number) |

---

Source of truth for auction rules and the bidding algorithm:
`docs/BACKEND_SPEC.md`. Project conventions and hard rules: `CLAUDE.md`.
Both are checked into the repository and kept current with the code.
