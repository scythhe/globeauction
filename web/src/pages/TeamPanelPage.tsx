import { useEffect, useState, type FormEvent } from "react";
import { api, type Vehicle } from "../api.ts";
import { errorMessage } from "../AuthContext.tsx";

interface TeamUser {
  id: string;
  email: string;
  fullName: string;
  role: string;
  depositAmount: string | null;
  depositReceivedAt: string | null;
  canBid: boolean;
}

function toLocalDatetimeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function TeamPanelPage() {
  const [vehicleId, setVehicleId] = useState("");
  const [vehicleForm, setVehicleForm] = useState({ make: "", model: "", year: "" });
  const [vehicleError, setVehicleError] = useState<string | null>(null);

  const [auctionForm, setAuctionForm] = useState({
    startingPrice: "",
    reservePrice: "",
    startsAt: toLocalDatetimeInput(new Date()),
    endsAt: toLocalDatetimeInput(new Date(Date.now() + 24 * 60 * 60 * 1000)),
  });
  const [auctionError, setAuctionError] = useState<string | null>(null);
  const [auctionCreated, setAuctionCreated] = useState<string | null>(null);

  const [users, setUsers] = useState<TeamUser[] | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);

  async function loadUsers() {
    try {
      const list = await api.get<TeamUser[]>("/admin/users");
      setUsers(list);
    } catch (err) {
      setUsersError(errorMessage(err));
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  async function handleCreateVehicle(e: FormEvent) {
    e.preventDefault();
    setVehicleError(null);
    try {
      const vehicle = await api.post<Vehicle>("/vehicles", {
        make: vehicleForm.make,
        model: vehicleForm.model,
        year: Number(vehicleForm.year),
      });
      setVehicleId(vehicle.id);
      setVehicleForm({ make: "", model: "", year: "" });
    } catch (err) {
      setVehicleError(errorMessage(err));
    }
  }

  async function handleCreateAuction(e: FormEvent) {
    e.preventDefault();
    setAuctionError(null);
    setAuctionCreated(null);
    try {
      const auction = await api.post<{ id: string }>("/auctions", {
        vehicleId,
        startingPrice: Number(auctionForm.startingPrice),
        reservePrice: Number(auctionForm.reservePrice),
        startsAt: new Date(auctionForm.startsAt).toISOString(),
        endsAt: new Date(auctionForm.endsAt).toISOString(),
      });
      setAuctionCreated(auction.id);
    } catch (err) {
      setAuctionError(errorMessage(err));
    }
  }

  async function handleDeposit(userId: string) {
    try {
      await api.post(`/admin/users/${userId}/deposit`, { amount: 500 });
      await loadUsers();
    } catch (err) {
      setUsersError(errorMessage(err));
    }
  }

  async function handleEnableBidding(userId: string) {
    try {
      await api.post(`/admin/users/${userId}/enable-bidding`);
      await loadUsers();
    } catch (err) {
      setUsersError(errorMessage(err));
    }
  }

  return (
    <div className="team-panel">
      <section>
        <h3>1. Create this week's vehicle</h3>
        <form onSubmit={handleCreateVehicle} className="inline-form">
          <input
            placeholder="Make"
            value={vehicleForm.make}
            onChange={(e) => setVehicleForm({ ...vehicleForm, make: e.target.value })}
            required
          />
          <input
            placeholder="Model"
            value={vehicleForm.model}
            onChange={(e) => setVehicleForm({ ...vehicleForm, model: e.target.value })}
            required
          />
          <input
            placeholder="Year"
            type="number"
            value={vehicleForm.year}
            onChange={(e) => setVehicleForm({ ...vehicleForm, year: e.target.value })}
            required
          />
          <button type="submit">Create vehicle</button>
        </form>
        {vehicleError && <p className="error">{vehicleError}</p>}
      </section>

      <section>
        <h3>2. Create the auction</h3>
        <form onSubmit={handleCreateAuction} className="inline-form">
          <label>
            Vehicle ID
            <input
              value={vehicleId}
              onChange={(e) => setVehicleId(e.target.value)}
              placeholder="from step 1, or paste one"
              required
            />
          </label>
          <label>
            Starting price (₾)
            <input
              type="number"
              value={auctionForm.startingPrice}
              onChange={(e) =>
                setAuctionForm({ ...auctionForm, startingPrice: e.target.value })
              }
              required
            />
          </label>
          <label>
            Reserve price (₾) — must be ≥ starting price
            <input
              type="number"
              value={auctionForm.reservePrice}
              onChange={(e) => setAuctionForm({ ...auctionForm, reservePrice: e.target.value })}
              required
            />
          </label>
          <label>
            Starts at
            <input
              type="datetime-local"
              value={auctionForm.startsAt}
              onChange={(e) => setAuctionForm({ ...auctionForm, startsAt: e.target.value })}
              required
            />
          </label>
          <label>
            Ends at
            <input
              type="datetime-local"
              value={auctionForm.endsAt}
              onChange={(e) => setAuctionForm({ ...auctionForm, endsAt: e.target.value })}
              required
            />
          </label>
          <button type="submit">Create auction</button>
        </form>
        {auctionError && <p className="error">{auctionError}</p>}
        {auctionCreated && <p>Created auction {auctionCreated}</p>}
      </section>

      <section>
        <h3>Buyers awaiting vetting</h3>
        {usersError && <p className="error">{usersError}</p>}
        {!users ? (
          <p>Loading...</p>
        ) : users.length === 0 ? (
          <p>Nobody waiting.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Deposit</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.fullName}</td>
                  <td>{u.email}</td>
                  <td>{u.depositReceivedAt ? `${u.depositAmount} ₾ received` : "none"}</td>
                  <td>
                    {!u.depositReceivedAt && (
                      <button type="button" onClick={() => handleDeposit(u.id)}>
                        Record 500 ₾ deposit
                      </button>
                    )}
                    {u.depositReceivedAt && (
                      <button type="button" onClick={() => handleEnableBidding(u.id)}>
                        Enable bidding
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
