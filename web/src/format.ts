export function gel(amount: string | number): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  return `${n.toLocaleString("en-US")} ₾`;
}
