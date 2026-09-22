export function gel(amount: string | number): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  return `${n.toLocaleString("en-US")} ₾`;
}

// Decimal-string addition/subtraction via integer cents, not Number() —
// this only ever feeds the stepper's *displayed* value (the server
// independently validates whatever string actually gets submitted, per
// place_bid()'s own rules), but a plain float add can still produce
// something like "1000.30000000000001", which both looks wrong and can
// fail the backend's decimal-string validation. Both amounts are always
// at most 2 decimal places (Postgres numeric(12,2)/bid_increment()), so
// cents-based integer math is exact.
function toCents(amount: string): number {
  return Math.round(Number(amount) * 100);
}
function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
export function addGel(a: string, b: string): string {
  return fromCents(toCents(a) + toCents(b));
}
export function subtractGel(a: string, b: string): string {
  return fromCents(toCents(a) - toCents(b));
}

// BACKEND_SPEC.md §10: GEL is the working currency; USD is a display-only
// conversion computed at render time, never stored, never compared
// against — nearest whole dollar. `gelRate` is GEL-per-1-USD, so the USD
// figure is priceGel / gelRate. Returns null when there's no rate to
// convert with (gel_rate wasn't set on this auction), so callers can hide
// the line entirely instead of showing a bogus "$0".
export function usdEquivalent(priceGel: string | number, gelRate: string | number | null): string | null {
  if (gelRate === null) return null;
  const price = typeof priceGel === "string" ? Number(priceGel) : priceGel;
  const rate = typeof gelRate === "string" ? Number(gelRate) : gelRate;
  if (!Number.isFinite(price) || !Number.isFinite(rate) || rate <= 0) return null;
  return `≈ $${Math.round(price / rate).toLocaleString("en-US")}`;
}
