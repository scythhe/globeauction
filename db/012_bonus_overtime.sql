-- 012_bonus_overtime.sql
-- A separate, one-time "sudden death" mechanic on top of the existing
-- per-bid soft close (db/011): the first time an auction is about to
-- close with a winner in place, give it one more soft_close_extension's
-- worth of time instead of closing outright, so a bidder who was about
-- to be outrun by silence gets one last look. Purely a closing-job
-- concern — place_bid() and the per-bid soft close it already performs
-- are untouched by this. Granted at most once per auction: the second
-- time an auction with this flag already set reaches ends_at quietly, it
-- closes for real, same as before this migration.

alter table auctions add column bonus_extension_used boolean not null default false;
