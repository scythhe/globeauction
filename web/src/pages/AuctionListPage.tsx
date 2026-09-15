import { useEffect, useState } from "react";
import { api, type Auction, type Vehicle } from "../api.ts";
import { errorMessage } from "../AuthContext.tsx";

interface Row {
  auction: Auction;
  vehicle: Vehicle | null;
}

export function AuctionListPage({ onSelect }: { onSelect: (auctionId: string) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const auctions = await api.get<Auction[]>("/auctions");
        const withVehicles = await Promise.all(
          auctions.map(async (auction) => {
            try {
              const vehicle = await api.get<Vehicle>(`/vehicles/${auction.vehicle_id}`);
              return { auction, vehicle };
            } catch {
              return { auction, vehicle: null };
            }
          }),
        );
        if (!cancelled) setRows(withVehicles);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!rows) return <p>Loading...</p>;
  if (rows.length === 0) return <p>No auctions yet.</p>;

  return (
    <ul className="auction-list">
      {rows.map(({ auction, vehicle }) => (
        <li key={auction.id}>
          <button type="button" className="auction-card" onClick={() => onSelect(auction.id)}>
            <strong>
              {vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "Vehicle"}
            </strong>
            <span className={`status status-${auction.status}`}>{auction.status}</span>
            <span>{Number(auction.current_price).toLocaleString()} ₾</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
