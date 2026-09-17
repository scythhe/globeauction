export function gel(amount: string | number): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  return `${n.toLocaleString("en-US")} ₾`;
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
