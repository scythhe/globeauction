import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Auction, type Bid, type Vehicle } from "../api.ts";
import { useAuth, errorMessage } from "../AuthContext.tsx";

export function AuctionDetailPage({
  auctionId,
  onBack,
}: {
  auctionId: string;
  onBack: () => void;
}) {
  const { user } = useAuth();
  const [auction, setAuction] = useState<Auction | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [bids, setBids] = useState<Bid[]>([]);
  const [maxAmount, setMaxAmount] = useState("");
  const [bidError, setBidError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    try {
      const a = await api.get<Auction>(`/auctions/${auctionId}`);
      setAuction(a);
      const [v, b] = await Promise.all([
        api.get<Vehicle>(`/vehicles/${a.vehicle_id}`),
        api.get<Bid[]>(`/auctions/${auctionId}/bids`),
      ]);
      setVehicle(v);
      setBids(b);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auctionId]);

  async function handleBid(e: FormEvent) {
    e.preventDefault();
    setBidError(null);
    setSubmitting(true);
    try {
      await api.post(`/auctions/${auctionId}/bids`, { max_amount: Number(maxAmount) });
      setMaxAmount("");
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "bid_too_low") {
        setBidError(`Too low — minimum is ${err.extra.minimum} ₾`);
      } else {
        setBidError(errorMessage(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) return <p className="error">{loadError}</p>;
  if (!auction || !vehicle) return <p>Loading...</p>;

  const canBid = user?.role === "buyer" || user?.role === "dealer";
  const isLive = auction.status === "live";

  return (
    <div>
      <button type="button" className="link" onClick={onBack}>
        ← back
      </button>
      <h2>
        {vehicle.year} {vehicle.make} {vehicle.model}
      </h2>
      <p className={`status status-${auction.status}`}>{auction.status}</p>
      {vehicle.color && <p>Color: {vehicle.color}</p>}
      {vehicle.mileage !== null && <p>Mileage: {vehicle.mileage.toLocaleString()}</p>}
      {vehicle.location && <p>Location: {vehicle.location}</p>}
      {vehicle.description && <p>{vehicle.description}</p>}

      <h3>Current price: {Number(auction.current_price).toLocaleString()} ₾</h3>
      {auction.reserveMet !== undefined && (
        <p>{auction.reserveMet ? "Reserve met" : "Reserve not yet met"}</p>
      )}
      {auction.reserve_price && <p>Reserve: {Number(auction.reserve_price).toLocaleString()} ₾ (team view)</p>}

      {isLive && canBid && user?.canBid && (
        <form onSubmit={handleBid} className="bid-form">
          <label>
            Your maximum bid (₾)
            <input
              type="number"
              value={maxAmount}
              onChange={(e) => setMaxAmount(e.target.value)}
              min={0}
              step="1"
              required
            />
          </label>
          {bidError && <p className="error">{bidError}</p>}
          <button type="submit" disabled={submitting}>
            {submitting ? "..." : "Place bid"}
          </button>
        </form>
      )}
      {isLive && canBid && !user?.canBid && (
        <p className="hint">Bidding isn't enabled on your account yet — contact the team.</p>
      )}
      {isLive && !canBid && user && <p className="hint">Team accounts can't bid.</p>}
      {isLive && !user && <p className="hint">Log in to bid.</p>}

      <h3>Bid history</h3>
      {bids.length === 0 ? (
        <p>No bids yet.</p>
      ) : (
        <ul className="bid-list">
          {bids.map((b) => (
            <li key={b.id}>
              {Number(b.amount).toLocaleString()} ₾{b.is_proxy ? " (proxy)" : ""} —{" "}
              {new Date(b.created_at).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
