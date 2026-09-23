# Auction platform — backend specification

Internal online car auction for Global Auto Import. Standalone system: own users,
own vehicles, own database. No live dependency on the existing company system.

Stack: Node + TypeScript, Postgres, S3-compatible object storage for photos.

Reference point: Lion Auctions runs the closest comparable model in Georgia —
24-hour web auctions, deposit required to bid, proxy bidding, and an "on approval"
path when the reserve isn't met. Defaults below follow that where it makes sense,
because it's what buyers here already expect.

---

## 1. Phase 1 scope

Phase 1 (~3 months) is company-owned inventory only: one lot per week, closing
Friday. There is no dealer submission flow yet.

- Every auction's vehicle is owned by the company. Every lot carries a mandatory
  reserve at the normal listing price — enforced in the schema by
  `auctions_phase1_reserve_required` — so an auction can never sell a car below
  what the company would have accepted anyway. Drop that constraint only when
  opening the platform to third-party sellers.
- The `dealer` role and the `counteroffers` table exist in the schema (see §6)
  but go unused in phase 1: no dealer submits vehicles, and every lot's owner is
  a `team` account, so seller-side decisions on a lot below reserve are made by
  `team`, not a dealer. Don't remove either — they're built for phase 2 — but
  don't build UI for them yet.
- `vehicles.status` still runs through `draft → pending → approved / rejected`
  in the schema, but phase 1 code never drives that transition. Team creates
  each week's vehicle directly in `approved` — no submit action, no approval
  queue screen, no `reject_reason`. Nothing in phase 1 should ever set a
  vehicle to `pending`. The states exist so phase 2 doesn't need a migration
  when dealer submission is built; an approval queue that's always empty in
  phase 1 is expected, not a bug to chase.
- Buyers still need vetting and `can_bid` enablement (§1.1) — that part is live
  from day one, it just doesn't depend on dealer/counteroffer machinery.

Everything below describes the full system the schema is built toward. Where a
piece is phase-2-only, it's called out inline.

---

## 2. Roles and organizations

| Role | Can do |
|---|---|
| `team` | Approve/reject vehicle submissions, create and cancel auctions, enable bidding for users, view everything |
| `dealer` *(phase 2)* | Submit own vehicles, accept/decline/counter when reserve isn't met, bid on vehicles outside their organization |
| `buyer` | Bid. Consignment (a buyer asking the team to sell their car) is phase 2 — see §17 |

Rules that hold regardless of role:

- **Nobody can bid on a vehicle owned by their own organization.** Not just their
  own account — the whole org. A dealer with a second account is still blocked.
  Enforced inside the bid function, not only in the API layer.
- **`team` accounts cannot bid at all.** An admin must not be able to push a price
  up on company inventory.
- **Bidding is off by default.** `users.can_bid` starts false. A team member turns
  it on after the buyer is vetted or has left a deposit. This is the gate that
  stops bids from people who will never pay.
- Only `team` can move a vehicle to `approved` or `rejected`.
- Only `team` can create an auction, and only for a vehicle in `approved` status.
- A dealer only sees their own vehicles in draft/pending/rejected. Approved
  vehicles on live auctions are public.

### 2.1 Buyer vetting

Vetting is manual in phase 1: team calls the buyer, takes a bank transfer, then
enables bidding by hand. The schema carries this directly on `users`:

- `phone_verified` — set once the buyer's phone is confirmed.
- `id_document_number` — captured during vetting.
- `deposit_amount`, `deposit_received_at` — set when a deposit is taken.
- `bid_limit` — caps total exposure; convention is `deposit_amount × 10`.
- `can_bid`, `bid_enabled_by`, `bid_enabled_at` — the actual gate, and who threw it.

**Decided:** a 500 GEL deposit is mandatory before `can_bid` is set. Phone
verification and ID capture still happen as part of the same call, but the
deposit is the actual gate — team doesn't flip `can_bid` until
`deposit_received_at` is set. This may change once there's real volume to
judge it against.

`deposit_amount` is GEL, same as every other money column now (§10) — the
mismatch flagged in an earlier draft of this spec (deposit in GEL, everything
else in USD) is resolved by that decision, not by treating the deposit as a
special case. `bid_limit = deposit_amount × 10` is therefore unambiguous:
5,000 ₾.

---

## 3. Vehicle lifecycle

```
draft ──submit──> pending ──approve──> approved
                     │
                     └──reject──> rejected ──edit+submit──> pending
```

- `draft` — dealer is still filling it in. Editable.
- `pending` — submitted. Read-only for the dealer. Appears in the team's queue.
- `approved` — eligible to be put on an auction. Editable only by team.
- `rejected` — carries `reject_reason`. Dealer can edit and resubmit.

**Phase 1 doesn't drive this state machine.** There's no dealer, so there's
nothing to submit and nothing to approve. Team creates each vehicle directly
in `approved` and skips `draft`/`pending`/`rejected` entirely — no submit
action, no approval queue, no reject reasons, in either the API or the UI.
The states stay in the schema for phase 2 only; if the approval queue looks
permanently empty in week two, that's correct, not a bug.

A vehicle that has been on a completed auction stays `approved` and can be relisted.

### 3.1 What a listing has to contain

Phase 1 inventory is customs-cleared retail stock from glob.ge/globmarket.ge,
not salvage — the schema's field set follows a globmarket listing, not an
insurance-auction one.

**Identity** — VIN, make, model, year, body style, color.

**Drivetrain** — engine volume (litres), cylinders, fuel type, transmission,
drive type, door count, steering side (left/right), airbag count.

**Interior** — color, material.

**Odometer** — mileage, unit (mi/km), and whether the reading is accurate.

**Georgian market status** — these decide whether a car is sellable here:
customs cleared (განბაჟებული), tech inspection passed (ტექ. დათვალიერება),
catalytic converter present (კატალიზატორი).

**Features** — a free-form equipment list (`features` jsonb array), e.g.
`["climate_control", "sunroof", "heated_seats"]`.

**Location and description** — free text, e.g. თბილისი.

**Condition fields kept for later** — `damage_primary` / `damage_secondary`,
`run` (run and drive / starts / not ready / unknown), `has_keys`,
`airbags_deployed`, `title` (clean / salvage / rebuilt / bill of sale /
unknown), `title_country`, `condition_notes`. These exist in the schema for a
future salvage-lot use case; phase 1 retail stock leaves them null or
`unknown`.

Photos matter as much as fields. Minimum 10 per listing, target 25–40. Exterior
from every angle, interior, dash with odometer visible, engine bay, VIN plate.

---

## 4. Auction lifecycle

```
scheduled ──starts_at reached──> live
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
              no bids at      reserve met    reserve not met
               ends_at            │              │
                    │             │              │
                    v             v              v
                 unsold         sold      pending_seller
                                                 │
                              ┌──────────────────┼──────────────────┐
                           accept              counter        decline / timeout
                              │                  │                   │
                              v                  v                   v
                            sold        counter_offered            unsold
                                                 │
                                     ┌───────────┴───────────┐
                                buyer accepts        buyer declines
                                     │                or timeout
                                     v                     v
                                   sold                 unsold
```

Any status except `sold` / `unsold` can be moved to `cancelled` by team.

Default auction duration: **24 hours**, with a 2-minute soft close on top.

`pending_seller` carries a `seller_decision_by` deadline, default 48 hours.
A counteroffer carries its own `expires_at`, default 24 hours.
Either deadline passing with no response means `unsold`.

In phase 1 the "seller" on the `pending_seller` / `counter_offered` path is
always `team`, since every vehicle is company-owned (§1).

When a sale completes through a counteroffer, `final_price` is the counter amount,
not `current_price`. That's why `final_price` and `sold_to` exist as separate
columns — the hammer price and the sale price are not always the same number.

---

## 5. Bidding

The core of the system. Everything else is CRUD; this is the part that has to be
correct under concurrency.

### 5.1 Model

Every bid row stores two numbers:

- `amount` — what the bid currently stands at, publicly visible.
- `max_amount` — the ceiling the bidder is willing to reach. Never shown to anyone else.

When someone places a bid, they submit only their maximum. The system decides what
the bid actually stands at. Proxy rows (`is_proxy = true`) are inserted by the
system on a bidder's behalf when they get pushed up by a competitor.

`auctions.current_price` and `auctions.high_bid_id` are denormalised copies of the
winning state. They exist so the bid function has a single row to lock.

Every bid also records `ip_address` and `user_agent`. Never exposed publicly.
These exist so that a shill-bidding accusation can actually be investigated
instead of argued about.

### 5.2 Increment table

Minimum step between bids, by current price.

| Current price | Increment |
|---|---|
| under 500 | 25 |
| 500 – 999 | 50 |
| 1,000 – 4,999 | 100 |
| 5,000 – 9,999 | 250 |
| 10,000 – 24,999 | 500 |
| 25,000 and above | 1,000 |

Lives in code for now. Move to a table if it starts changing.

### 5.3 Algorithm

`place_bid(auction_id, bidder_id, max_amount, ip_address, user_agent, flat)` —
runs entirely inside one transaction, opened with
`SELECT ... FROM auctions WHERE id = $1 FOR UPDATE`. `flat` defaults to
`false` (ordinary Quick Bid); Monster Bid and pre-bidding pass `true` — see
the flat-bid note under Resolution below.

**Validation** (reject the whole transaction on any failure):

1. Auction exists and `status` is `live` **or `scheduled`** (db/013 —
   pre-bidding: a max bid placed before `starts_at` runs through this exact
   same algorithm, so competing pre-bids resolve via the normal Case A-E
   proxy logic ahead of time; whatever `current_price`/`high_bid_id` that
   settles on carries straight through when `openScheduledAuctions` flips
   the row to `live`). A `live` row with `starts_at` still in the future
   is rejected as defense in depth (shouldn't occur — the job only flips
   `scheduled -> live` once `starts_at <= now()` — but `scheduled` itself
   has no lower time bound; that's the entire point of pre-bidding).
2. `now()` is before `ends_at`.
3. Bidder is active, has role `dealer` or `buyer`, and `can_bid = true`.
4. Bidder's `organization_id` is not the vehicle owner's `organization_id`,
   and bidder is not the owner. Both checks — org may be null on a private buyer.
5. `max_amount` is at least the minimum acceptable bid:
   - No bids yet → `starting_price`
   - Otherwise → `current_price + increment(current_price)`

**Resolution**, given the existing high bid `H` (may be null):

*Case A — no existing bid.*
Insert a bid for the new bidder standing at `starting_price` (or, if `flat`, at
their own `max_amount`), with their `max_amount`. `current_price` = that same
standing amount.

*Case B — the new bidder already holds the high bid.*
Do not insert a visible bid. Raise their existing row's `max_amount`.
`current_price` unchanged — unless `flat`, in which case the row's `amount`
and `current_price` both move to the new `max_amount` too. (This is a bidder
increasing their own ceiling.)

*Case C — new `max_amount` > `H.max_amount`.* The new bidder takes the lead.
1. Insert a proxy bid for the old holder standing at `H.max_amount`.
2. Insert the new bidder's bid standing at `min(H.max_amount + increment, max_amount)`
   — or, if `flat`, at their own `max_amount` outright.
3. `current_price` = that value, `high_bid_id` = the new bid.

*Case D — new `max_amount` <= `H.max_amount`.* The old holder retains the lead.
1. Insert the new bidder's bid standing at their `max_amount`. They have lost.
2. Insert a proxy bid for the old holder standing at
   `min(max_amount + increment, H.max_amount)`.
3. `current_price` = that value, `high_bid_id` = the old holder's proxy bid.
   `flat` makes no difference here — the bidder didn't take the lead, so
   there is nothing of theirs to publish; the value that resolves belongs to
   the old holder's own real ceiling, which a flat bid cannot override.

*Case E — exact tie on maximums.* Earliest `created_at` wins. Falls under case D.

**Flat bids (db/014).** Quick Bid is a proxy bid: `max_amount` is a private
ceiling, and the engine reveals only as much of it as needed to lead
(`current_price` rises in small steps, one increment past whoever is second).
Monster Bid and pre-bidding are not — the whole point of dialing in a big,
deliberate number is to publish it, not to hide it behind proxy compression.
Passing `flat = true` makes `current_price` equal the bidder's own
`max_amount` outright in every case where that bid becomes (or already is)
the high bid (A, B, C) — never in Case D, where the number that resolves
isn't this bidder's to reveal in the first place.

**Soft close:**

After a successful bid, if `ends_at - now() < soft_close_window`, set
`ends_at = now() + soft_close_window`. This is what stops last-second sniping.
There is no cap on extensions — an auction with two determined bidders keeps
going until one stops.

**Commit.** Update `auctions.current_price`, `high_bid_id`, `ends_at`, `updated_at`.

### 5.4 Why the lock matters

Two bidders hitting the same lot within the same millisecond is the normal case at
the end of an auction, not an edge case. Without `FOR UPDATE` on the auction row,
both transactions read the same `current_price`, both compute the same next step,
and both insert — producing two bids at the same amount and a corrupted high-bid
pointer. That is a real-money dispute with a dealer.

Never compute a bid from a value read in an earlier request. Read and write inside
the same locked transaction.

---

## 6. Reserve, seller decision, counteroffer

The seller never bids. Their control over price is exercised through three
explicit, logged actions instead.

- **Reserve price** — set when the auction is created. Not shown to bidders; the
  listing shows only whether the reserve has been met. In phase 1 it is always
  set to at least the normal listing price (§1).
- **Accept / decline** — when the auction ends below reserve, the seller has 48
  hours to take the high bid or walk away.
- **Counteroffer** — instead of either, the seller may name a price to the high
  bidder. That buyer has 24 hours to accept or decline. Only one counter open at
  a time per auction. *(Phase 2 — the `counteroffers` table exists but is unused
  while the company is the only seller; see §1.)*

This is deliberately the alternative to seller-side bidding. A seller bidding on
their own lot to push a price up is shill bidding — it is fraud in most
jurisdictions and it permanently destroys dealer and buyer trust. The schema makes
it impossible at organization level and logs every bid's origin. If pressure ever
appears to allow it, the answer is a disclosed reserve, not a hidden account.

---

## 7. Post-sale settlement

**Decided.** Once an auction reaches `sold`, payment happens outside the
platform: team contacts the winner (`sold_to`) and the winner bank-transfers
`final_price` to the company. If the winner doesn't pay, the sale goes to the
underbidder as a second chance instead of relisting.

There's no schema support for this yet — no payment deadline column, no
payment-status field, no "offered to underbidder" state. For one car a week,
that's the right call for now: team tracks the payment deadline manually
(calendar, spreadsheet, whatever), and reassignment is a manual admin action,
not an automated job. Revisit only if missed payments become frequent enough
that tracking them by hand starts causing mistakes.

**Process:**

1. Auction closes `sold`. `final_price` and `sold_to` are set by the
   background job (§8) or by team accepting/countering a below-reserve bid (§6).
2. Team contacts the winner (phone/email, outside the system) with the amount
   and transfer instructions.
3. **Payment deadline — confirmed: 48 hours** from the `sold` timestamp,
   matching the seller-decision deadline elsewhere in this spec.
4. If the winner pays: done, no schema change. (How payment gets recorded —
   even just a note field — is worth a small follow-up migration once phase 1
   is live; not blocking the first auction.)
5. If the winner doesn't pay by the deadline: team manually reassigns the sale
   to the underbidder — the bidder with the next-highest `amount` on that
   auction, found via `GET /auctions/:id/bids` (already public, ordered by
   `amount desc`). Team calls `POST /admin/auctions/:id/reassign-sale` (new,
   team-only — see §12) with the underbidder's id; it overwrites `sold_to` and
   `final_price` in place. `status` stays `sold` throughout — there's no
   dedicated "second chance" status, since nothing in the schema needs one for
   a single manual reassignment.
6. If the underbidder also doesn't pay, or there is no underbidder: team
   cancels manually (no automated fallback in phase 1).

This is intentionally thin. It gets a live auction running in the timeline
you set without a schema change; it is not meant to survive unmodified once
there's more than one car a week to chase payment on.

---

## 8. Background jobs

One process on the API server, running every 1 second (originally 30s — see
below for why that changed). Each job uses `FOR UPDATE SKIP LOCKED` so a
second instance doesn't double-process.

**Open scheduled auctions.**
`status = 'scheduled' AND starts_at <= now()` → `live`.

**Close expired auctions.**
`status = 'live' AND ends_at <= now()`, then for each:
- No bids → `unsold`
- Has a high bid and `bonus_extension_used` is not yet set → grant a
  one-time bonus round instead of closing: `ends_at = now() + soft_close_extension`,
  `bonus_extension_used = true`. Separate mechanism from place_bid()'s own
  per-bid soft close (§5.3) — fires on silence rather than on a bid, and
  only ever once per auction (db/012).
- `reserve_price` is null, or `current_price >= reserve_price` → `sold`
  (set `final_price = current_price`, `sold_to` = high bidder, `sold_at = now()`)
- Otherwise → `pending_seller`, `seller_decision_by = now() + 48 hours`

**Expire seller decisions.**
`status = 'pending_seller' AND seller_decision_by <= now()` → `unsold`.

**Expire counteroffers.**
Open counteroffers past `expires_at` → mark `accepted = false`, auction → `unsold`.

30-second granularity was originally fine because soft close means the exact
closing instant is never contested — the last bid already pushed the deadline
out. That reasoning doesn't hold for the bonus round above, which fires on
*silence*: at 30s granularity a still-live auction with a winner can sit
looking closed for up to half a minute before the bonus round revives it,
which reads as broken rather than dramatic. Dropped to 1 second so the bonus
round (and every other transition here) lands close to instantly — cheap at
phase 1's volume of one lot a week.

---

## 9. Notifications

Not optional. Proxy bidding does not work without outbid alerts — a bidder who is
never told they've been beaten cannot raise their maximum, and the lot closes
below what it was worth.

v1, email is enough:

- **Outbid** — you are no longer the high bidder on lot X.
- **Auction ending** — 1 hour before close, to everyone who has bid.
- **Won** — you won lot X, here is what happens next (team will contact you to
  arrange payment; see §7).
- **Reserve not met** — to the seller, with the accept/decline/counter link.
- **Counteroffer received** — to the high bidder, with the deadline.
- **Vehicle approved / rejected** — to the dealer.

Send from a job, not inline in the bid transaction. A failing mail server must
never roll back a bid.

**Implemented (phase 1): outbid, ending-soon, reserve-not-met.** "Won" is
deliberately not sent — you asked to skip it, and the team already contacts
the winner directly as the first step of §7's payment process, so an
automated email would just be redundant. Counteroffer and vehicle
approved/rejected don't apply yet — both belong to phase-2 machinery
(counteroffers, dealer submission) that doesn't exist in phase 1.

`db/005_notification_log.sql` adds a `notification_log` table purely for
idempotency: the job runs every 30 seconds and needs to know what it's
already generated, since nothing here is in-memory across restarts. Each
kind has its own uniqueness rule — one `outbid` per bid event (keyed by
`bid_id`), one `ending_soon` per (auction, bidder) pair, one
`reserve_not_met` per auction. A row is only marked sent after the mailer
call succeeds; if it throws, the whole insert rolls back and the next tick
picks the candidate up again — same "never lose an event, never double-send
a successful one" contract as the bid function's exception handling, just
at 30-second granularity instead of one transaction.

There's no real mail transport wired up — no SMTP relay or provider API
key exists yet, and CLAUDE.md says ask before adding a dependency, so
`api/src/notifications/mailer.ts` logs to the console behind the same
`Mailer` function signature a real transport would implement. Swapping it
in later is a one-file change, not a redesign.

---

## 10. Currency and fees

**Currency — decided, revised.** GEL is the working currency: every money
column that participates in bid maths — `starting_price`, `reserve_price`,
`current_price`, `bids.amount`, `bids.max_amount`, `users.deposit_amount`,
`users.bid_limit` — holds a GEL figure. USD is shown alongside as a
convenience conversion, never the other way around.

This is a change from the schema's own comment (`001_init.sql` says "All
money is USD ... gel_rate ... display only, never used in bid maths") and
from CLAUDE.md's hard rule #1 ("GEL is display only, converted from USD at
`auctions.gel_rate`"). Both describe the opposite direction. **Flagging this
explicitly because CLAUDE.md says to** — the schema itself doesn't need to
change (the numeric columns are currency-agnostic either way, and the "never
float, always numeric/SQL" half of the rule still holds exactly as written),
but the doc comment and CLAUDE.md's wording are now stale and should be
corrected to match this decision the next time either is touched.

`auctions.gel_rate` still does the conversion arithmetic — it just runs in
the other direction now. It stores the GEL-per-1-USD rate at auction-creation
time; a price's USD-equivalent for display is `price_gel / gel_rate`. Every
listing shows both, GEL first:

```
Current bid       14,000 ₾
                   ≈ $5,090
```

Rounding for the USD line: nearest whole dollar, computed at render time —
never stored, never compared against in the bid function. The invariant from
§14 still holds: all bid arithmetic happens in SQL/decimal on the GEL figure,
never in JavaScript, and USD is cosmetic only.

**Fees — decided: none in phase 1.** The company is selling its own car; there's
no third party to take a cut from. `auctions.buyer_fee_percent` stays null on
every phase 1 auction and the UI shows no fee line. Leave the column alone —
it's there for when phase 2 introduces dealer-owned cars and a real fee model,
not something to populate or hide conditionally now. If a fee is ever added,
the display would be:

```
Current bid          14,000 ₾
Buyer fee (5%)           700 ₾
──────────────────────────────
Your total            14,700 ₾
                       ≈ $5,340
```

---

## 11. Photos

Dealers (in phase 1, team) upload directly to object storage using presigned
URLs. The API never proxies image bytes.

1. Client calls `POST /vehicles/:id/photos`, gets a presigned PUT URL and a key.
2. Client uploads the file straight to storage.
3. Client calls back to confirm; API inserts the `vehicle_photos` row.

Limits: 40 photos per vehicle, 10 MB each, jpeg/png/webp only. Validate the
content type when issuing the presigned URL, not after. These limits are
enforced in the API — the schema only stores `url` and `sort_order` per photo.

Minimum: 1. `POST /auctions` rejects with `vehicle_has_no_photos` if the
vehicle has zero photos at the moment the auction is created — a bidder
can't evaluate a car they can't see, and phase 1 has no photo requirement
at vehicle-approval time (a vehicle can sit `approved` for a while, with
photos still being added right up until the auction is actually created).

There's no separate "primary photo" column. Whichever photo holds
`sort_order = 0` is the cover shot — the same ordering the list page's
first-photo display already used, so a second `is_primary` flag would just
be the same fact stored twice. `POST /vehicles/:id/photos/:photoId/primary`
(team-only) reorders by swapping that photo's `sort_order` with whichever
currently holds 0.

**Implemented.** Content type is checked before a URL is ever handed out —
the presigned PUT is signed with that content type, so uploading with a
different header fails the signature at the storage layer, not just a
client-side check. The 10 MB limit can't be enforced by a presigned PUT
directly (that needs presigned POST with policy conditions, which felt like
more moving parts than one car a week justifies), so it's enforced at
confirm time instead: `HeadObject` checks the actual uploaded size, and an
oversized file gets deleted from storage and rejected rather than trusted.
Same for content type — confirmed against what was actually stored, not
just what the client claimed when requesting the URL.

Uses the AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
against whatever `S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/etc. point to — real
Cloudflare R2 in production, or a local MinIO stand-in for dev (`brew
install minio`, or the `minio` service in `docker-compose.yml`). Same code
either way; R2 speaks the S3 API.

---

## 12. API surface

All routes under `/api`. JSON. Bearer token auth.

**Auth**
```
POST   /auth/register
POST   /auth/login
GET    /auth/me
```

**Vehicles** (team-only writes in phase 1 — §3, no dealer submission flow yet)
```
POST   /vehicles                    team only — creates directly in 'approved'
GET    /vehicles/:id                public
GET    /vehicles/available          team only — approved vehicles with no open auction, for the team panel's auction-creation picker
POST   /vehicles/:id/photos         team only — get a presigned upload URL (§11)
POST   /vehicles/:id/photos/confirm team only — confirm an upload, insert the vehicle_photos row
GET    /vehicles/:id/photos         public — list a vehicle's photos
POST   /vehicles/:id/photos/:photoId/primary  team only — make this photo sort_order 0 (§11)
DELETE /vehicles/:id/photos/:photoId  team only
```

**Vehicles** *(dealer — phase 2, not built)*
```
PATCH  /vehicles/:id                edit draft or rejected
POST   /vehicles/:id/submit         draft -> pending
GET    /vehicles                    own vehicles
GET    /vehicles/:id
```

**Team**
```
GET    /admin/vehicles?status=pending
POST   /admin/vehicles/:id/approve
POST   /admin/vehicles/:id/reject         { reason }
GET    /admin/users?can_bid=false
POST   /admin/users/:id/enable-bidding
```

**Auctions**
```
POST   /auctions                          team only
GET    /auctions?status=live|upcoming&q=&make=&year=&damage=&run=
GET    /auctions/:id
GET    /auctions/:id/bids                 public history, no max_amount, no IP
POST   /auctions/:id/cancel               team only
```

**Bidding**
```
POST   /auctions/:id/bids                 { max_amount }
```

**Seller decision** (vehicle owner, status = pending_seller — team, in phase 1)
```
POST   /auctions/:id/accept
POST   /auctions/:id/decline
POST   /auctions/:id/counter              { amount }
```

**Counteroffer response** *(phase 2 — high bidder, status = counter_offered)*
```
POST   /auctions/:id/counter/accept
POST   /auctions/:id/counter/decline
```

**Post-sale settlement** (team only, status = sold — see §7)
```
POST   /admin/auctions/:id/reassign-sale   { sold_to: userId }
```

### Response shape for a bid rejection

Return a structured reason, not a string. The frontend needs to show
"minimum bid is 4,100 ₾", not "bad request". `minimum` and `current_price`
are GEL figures, matching every other money value in this API (§10) — the
frontend converts to a USD-equivalent for display, it never asks the API for one.

```json
{ "error": "bid_too_low", "minimum": 4100, "current_price": 4000 }
```

Distinct error codes needed: `bid_too_low`, `auction_not_live`, `bidding_disabled`,
`own_organization`, `account_inactive`.

---

## 13. Invariants

Things that must always be true. Worth writing tests for these specifically.

1. `auctions.current_price` equals the `amount` of the bid referenced by `high_bid_id`.
2. A vehicle has at most one auction in `scheduled`, `live`, `pending_seller`, or
   `counter_offered` at a time. (Enforced by partial unique index.)
3. No bid exists whose bidder shares an organization with the vehicle's owner.
4. No bid exists from a user with role `team`.
5. No bid exists from a user with `can_bid = false` at the time of bidding.
6. Bids on an auction never decrease in `amount` over time.
7. `max_amount >= amount` on every bid row.
8. An auction in `sold` has non-null `final_price` and `sold_to`.
9. `ends_at` only ever moves forward, never backward.
10. At most one counteroffer per auction is open at a time.
11. Every `auctions` row in phase 1 has a non-null `reserve_price` (enforced by
    `auctions_phase1_reserve_required`).

---

## 14. Security notes

- Passwords: argon2id. Not bcrypt, not sha256.
- `max_amount` is never returned to anyone other than the bidder who set it.
  Leaking it makes proxy bidding pointless.
- `ip_address` and `user_agent` on bids are team-only, never in a public response.
- Role and `can_bid` checks happen in the service layer, not only in route
  middleware. A route that forgets its middleware should still fail.
- Rate limit `POST /auctions/:id/bids` per user. Not for load — to stop a script
  walking an opponent's ceiling up with repeated minimum bids.
- All money as `numeric`, never floating point. Never do arithmetic on prices in
  JavaScript; do it in SQL or with a decimal library.

---

## 15. Build status

Target: one fully live, secure auction on one company-owned car, in 1–2 weeks.
Everything marked *phase 2* below is explicitly out of scope for that target —
don't build it now.

| Piece | Status | Phase |
|---|---|---|
| Schema | Applied (`db/001_init.sql` + follow-on migrations 002–005) | 1 |
| Migrations runner | Done (`api/scripts/migrate.ts`) | 1 |
| Auth + roles + orgs | Done — register (buyer-only self-signup), login, DB-backed sessions | 1 |
| Vehicle creation (team, direct to `approved`) | Done | 1 |
| Dealer submission + approval queue | Not started | 2 |
| Deposit intake + bidder enablement (admin) | Done | 1 |
| Auction creation | Done | 1 |
| Bid function | Done, with A–E + concurrency tests (`db/002_bid_function.sql`) | 1 |
| Seller accept/decline (below reserve) | Done | 1 |
| Counteroffer | Not started | 2 |
| Post-sale settlement (§7 — manual, `reassign-sale`) | Done | 1 |
| Background jobs | Done — open scheduled, close expired, expire seller decisions | 1 |
| Notifications | Done — outbid, ending-soon, reserve-not-met. "Won" deliberately skipped (team contacts winners directly, §7); email transport is a `console.log` stub pending real SMTP/API credentials | 1 |
| Photo uploads | Done — presigned S3-compatible uploads, real R2 credentials still needed for prod | 1 |
| Search / home feed | Not started | later (single car/week doesn't need it) |
| Frontend | Done — auth, browse, bid, team panel (`/web`), Copart-matched UI, Buy It Now | 1 |
| i18n (Georgian/English/Russian) | Done — custom layer (`web/src/i18n/`), Georgian-first with a switcher, every user-facing string and backend error code covered. Georgian/Russian text is machine-drafted and wants a native-speaker pass before real bidders see it | 1 |

### Suggested order (for the 1–2 week target)

1. Migrations runner + apply schema locally.
2. Auth: register, login, `/auth/me`, role middleware, organizations. Only
   `team` and `buyer` need to work end-to-end; `dealer` just needs to exist.
3. Vehicle creation, team-only, straight to `approved` — no submit/approve
   endpoints (§3).
4. Deposit intake + bidder enablement, both manual/admin-driven (§2.1).
5. Auction creation, `GET /auctions`, `GET /auctions/:id`, `GET /auctions/:id/bids`.
6. **Bid function** — write the SQL function, then unit test cases A–E, then a
   concurrency test with parallel inserts. Slow down here regardless of the
   timeline; a bug here is a real-money dispute (§5.4).
7. Background jobs (§8): open scheduled, close expired, expire seller decisions.
   Skip the counteroffer-expiry job — no counteroffers exist yet.
8. Seller accept/decline on `pending_seller` (§6). Skip counter — phase 2.
9. Post-sale settlement (§7): `reassign-sale` endpoint, manual deadline tracking.
10. Notifications: outbid, ending-soon, won, reserve-not-met. Email is enough (§9).
11. Photo uploads (§11).
12. Frontend: browse/live-auction view, bid, minimal admin (create vehicle,
    create auction, enable bidding, reassign sale).

### What's left to actually go live

Every phase-1 line in the table above is done — this is now an operational
punch list, not a code one:

- **Real Cloudflare R2 credentials.** Photos work end-to-end against a local
  MinIO stand-in; swapping in production R2 is an env var change
  (`S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`S3_PUBLIC_BASE_URL`),
  not a code change.
- **Real email transport.** Notifications are correctly triggered and
  deduplicated; they currently log to the console instead of sending,
  because there's no SMTP relay or provider API key yet. One-file swap in
  `api/src/notifications/mailer.ts` once that's decided.
- **Deployment.** Nothing here has ever run anywhere but a local machine —
  hosting, a domain, TLS, and a process manager (or equivalent) for keeping
  the API and its background job loop alive are all still open.
- **A GEL→USD rate source**, if the USD display line in §10 is wanted from
  day one — right now `gel_rate` is only ever set if someone passes it in
  by hand at auction creation.
- **A native-speaker review of the Georgian and Russian translations**
  (`web/src/i18n/translations.ts`) — machine-drafted, not yet checked by a
  native speaker. Worth doing before the first real bidder sees them,
  especially the auction-mechanics copy (Max Bid, reserve, outbid).

Search, home feed, dealer submission, approval queue, and counteroffers are
all phase 2 — don't build them chasing "completeness" before the first
auction runs.

---

## 16. Decisions needed from the business

Resolved so far:

- **Fee model — decided.** None in phase 1. See §10.
- **Deposit policy — decided.** 500 GEL, mandatory before `can_bid`. See §2.1.
- **Post-sale process — decided.** Winner pays by bank transfer after team
  contacts them, with a **confirmed 48-hour deadline**; non-payment goes to
  the underbidder as a second chance, not a relist. See §7.
- **Definition of done — decided.** One fully live, secure auction on one
  company-owned car, running within 1–2 weeks. See §15.
- **Currency — decided, revised.** GEL is the working currency everywhere
  money participates in bid maths; USD is a display-only conversion, the
  reverse of what CLAUDE.md and the schema comment currently say. See §10 —
  including the note there that CLAUDE.md's hard rule #1 needs updating to
  match.
- **Language — decided.** All three ship for the first live auction, not
  Georgian-only-then-translate-later. Georgian is the default and the
  language every string is authored for first; English and Russian are
  switchable via a header control. See §15's build status — the i18n layer
  is done, not just wired up for later.

---

## 17. Open technical decisions

- **Postgres — decided.** Chosen over the company's MariaDB for tooling,
  `FOR UPDATE` ergonomics, and full-text search. Not revisiting this for phase 1.
- **Deposit currency — resolved.** The GEL-primary decision in §10 means
  `deposit_amount` is GEL like everything else; the earlier mismatch (deposit
  in GEL, prices in USD) no longer exists. Nothing left to reconcile here.
- **CLAUDE.md and the schema comment are stale on currency direction.**
  CLAUDE.md's hard rule #1 says "GEL is display only, converted from USD at
  `auctions.gel_rate`"; `001_init.sql`'s comment on the `auctions` table says
  the same ("All money is USD ... gel_rate ... display only"). §10 now says
  the opposite: GEL is the working currency, USD is the display conversion.
  No code or schema exists yet to actually contradict, so nothing is broken —
  but CLAUDE.md and that schema comment should be corrected to match this
  decision the next time either file is touched, so a future reader (or a
  future me) doesn't build against the old direction by mistake.
- **Sync with the company system.** `external_id` / `source` columns exist as the
  hook on `users` and `vehicles`. No sync job designed. Direction of truth not
  decided.
- **Live sequential sale.** Not built. Timed auctions only. A Copart-style live
  block needs websockets and a lot queue; revisit only if volume justifies it.
- **Consignment (buyer asks the team to sell their car) — cut from phase 1.**
  A buyer wanting to consign a car is the same problem as dealer submission:
  someone outside the company offering a vehicle. That's phase 2, by design
  (§1) — it isn't a gap to patch now. `001_init.sql` has no `listing_requests`
  table (only `organizations`, `users`, `vehicles`, `vehicle_photos`,
  `auctions`, `bids`, `counteroffers`), and phase 1 doesn't need one: the
  phone number already on every glob.ge/globmarket.ge page is the current
  mechanism, and it works. When phase 2 designs dealer submission, decide
  then whether a buyer-initiated request needs its own table or reuses that
  flow — don't build either ahead of it.
</content>
</invoke>
