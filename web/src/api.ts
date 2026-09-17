const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000/api";

export class ApiError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : "request_failed");
    this.status = status;
    this.code = this.message;
    this.extra = body;
  }
}

function getToken(): string | null {
  return localStorage.getItem("token");
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem("token", token);
  else localStorage.removeItem("token");
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw new ApiError(res.status, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  del: <T>(path: string) => request<T>("DELETE", path),
};

// ---------------------------------------------------------------
// Domain types — deliberately loose (matches the API's raw shape).
// Tighten these as the frontend grows past this first pass.
// ---------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  role: "team" | "dealer" | "buyer";
  fullName: string;
  canBid: boolean;
}

export interface Auction {
  id: string;
  vehicle_id: string;
  status: string;
  starting_price: string;
  current_price: string;
  gel_rate: string | null; // GEL-per-1-USD, set at auction creation — see format.ts usdEquivalent()
  reserve_price?: string; // present for team only
  reserveMet?: boolean; // present for everyone else
  nextMinimumBid: string;
  buy_now_price: string | null;
  high_bid_id: string | null;
  starts_at: string;
  ends_at: string;
  soft_close_window: string;
  final_price: string | null;
  sold_to: string | null;
}

export interface Vehicle {
  id: string;
  make: string;
  model: string;
  year: number;
  vin: string | null;
  body_style: string | null;
  color: string | null;
  engine_volume: string | null;
  cylinders: number | null;
  fuel_type: string | null;
  transmission: string | null;
  drive_type: string | null;
  doors: string | null;
  steering_side: string | null;
  interior_color: string | null;
  interior_material: string | null;
  mileage: number | null;
  mileage_unit: string;
  odometer_accurate: boolean | null;
  customs_cleared: boolean;
  tech_inspection: boolean | null;
  catalytic_converter: boolean | null;
  features: string[];
  // Salvage-lot fields (§3.1) — null/"unknown" for phase-1 retail stock,
  // meaningful once phase 2 lists damaged vehicles. Displayed only when set.
  damage_primary: string | null;
  damage_secondary: string | null;
  run: string;
  has_keys: boolean | null;
  title: string;
  location: string | null;
  description: string | null;
}

export interface VehiclePhoto {
  id: string;
  vehicle_id: string;
  url: string;
  sort_order: number;
}

export interface Bid {
  id: string;
  auction_id: string;
  bidder_id: string;
  amount: string;
  max_amount?: string; // team-only, or your own bid
  is_proxy: boolean;
  created_at: string;
}
