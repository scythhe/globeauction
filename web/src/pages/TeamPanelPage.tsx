import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { api, type Auction, type AuctionEvent, type Vehicle, type VehiclePhoto } from "../api.ts";
import { errorMessage } from "../AuthContext.tsx";
import { gel } from "../format.ts";
import { useTranslation } from "../i18n/index.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";

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

const inputClass =
  "w-full rounded border border-border bg-bg px-3 py-2 text-sm text-ink outline-none focus:border-brand";
const labelClass = "block text-sm";
const labelTextClass = "mb-1 block font-medium text-ink-muted";
const buttonClass =
  "rounded bg-brand px-4 py-2 text-sm font-semibold text-white shadow-[0_0_16px_-4px_var(--color-brand)] transition hover:bg-brand-hover disabled:opacity-50";
const sectionClass = "rounded-lg border border-border bg-surface p-5";

// The create-vehicle -> photos -> create-auction flow is a sequence, not
// three unrelated boxes — a numbered badge + connecting line says that at
// a glance instead of relying on a "1./2./3." text prefix buried in each
// heading, which read the same as every other section on this page.
function Step({
  number,
  title,
  last = false,
  children,
}: {
  number: number;
  title: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand font-display text-sm font-bold text-white shadow-[0_0_12px_-2px_var(--color-brand)]">
          {number}
        </span>
        {!last && <span className="mt-1 w-px flex-1 bg-border" />}
      </div>
      <div className={`min-w-0 flex-1 ${last ? "" : "pb-6"}`}>
        <h3 className="font-display mb-3 text-base font-semibold">{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function TeamPanelPage() {
  const { t } = useTranslation();
  const [vehicleId, setVehicleId] = useState("");
  const [vehicleForm, setVehicleForm] = useState({ make: "", model: "", year: "" });
  const [vehicleError, setVehicleError] = useState<string | null>(null);

  const [photos, setPhotos] = useState<VehiclePhoto[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const [auctionForm, setAuctionForm] = useState({
    startingPrice: "",
    reservePrice: "",
    buyNowPrice: "",
    gelRate: "",
    startsAt: toLocalDatetimeInput(new Date()),
    endsAt: toLocalDatetimeInput(new Date(Date.now() + 24 * 60 * 60 * 1000)),
  });
  const [auctionError, setAuctionError] = useState<string | null>(null);
  const [auctionCreated, setAuctionCreated] = useState<string | null>(null);

  const [users, setUsers] = useState<TeamUser[] | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [depositInputs, setDepositInputs] = useState<Record<string, string>>({});

  const [availableVehicles, setAvailableVehicles] = useState<Vehicle[] | null>(null);

  async function loadAvailableVehicles() {
    try {
      setAvailableVehicles(await api.get<Vehicle[]>("/vehicles/available"));
    } catch {
      setAvailableVehicles([]);
    }
  }

  async function loadUsers() {
    try {
      const list = await api.get<TeamUser[]>("/admin/users");
      setUsers(list);
    } catch (err) {
      setUsersError(errorMessage(err));
    }
  }

  interface ManagedAuction {
    auction: Auction;
    vehicle: Vehicle | null;
  }
  const [managedAuctions, setManagedAuctions] = useState<ManagedAuction[] | null>(null);
  const [managedError, setManagedError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reassignInputs, setReassignInputs] = useState<Record<string, string>>({});
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, AuctionEvent[]>>({});

  async function loadManagedAuctions() {
    try {
      const auctions = await api.get<Auction[]>("/auctions");
      const withVehicles = await Promise.all(
        auctions.map(async (auction) => {
          try {
            return { auction, vehicle: await api.get<Vehicle>(`/vehicles/${auction.vehicle_id}`) };
          } catch {
            return { auction, vehicle: null };
          }
        }),
      );
      setManagedAuctions(withVehicles);
    } catch (err) {
      setManagedError(errorMessage(err));
    }
  }

  useEffect(() => {
    loadUsers();
    loadManagedAuctions();
    loadAvailableVehicles();
  }, []);

  async function runAuctionAction(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
      await loadManagedAuctions();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function toggleHistory(auctionId: string) {
    if (openHistory === auctionId) {
      setOpenHistory(null);
      return;
    }
    setOpenHistory(auctionId);
    if (!history[auctionId]) {
      try {
        const events = await api.get<AuctionEvent[]>(`/auctions/${auctionId}/events`);
        setHistory((h) => ({ ...h, [auctionId]: events }));
      } catch (err) {
        setActionError(errorMessage(err));
      }
    }
  }

  async function loadPhotos(id: string) {
    try {
      setPhotos(await api.get<VehiclePhoto[]>(`/vehicles/${id}/photos`));
    } catch {
      setPhotos([]);
    }
  }

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
      setPhotos([]);
      await loadAvailableVehicles();
    } catch (err) {
      setVehicleError(errorMessage(err));
    }
  }

  async function handlePhotoSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !vehicleId) return;

    setPhotoError(null);
    setUploading(true);
    try {
      const { uploadUrl, key } = await api.post<{ uploadUrl: string; key: string }>(
        `/vehicles/${vehicleId}/photos`,
        { contentType: file.type },
      );
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "content-type": file.type },
      });
      if (!putRes.ok) throw new Error(`upload failed: ${putRes.status}`);
      await api.post(`/vehicles/${vehicleId}/photos/confirm`, { key });
      await loadPhotos(vehicleId);
    } catch (err) {
      setPhotoError(errorMessage(err));
    } finally {
      setUploading(false);
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
        buyNowPrice: auctionForm.buyNowPrice ? Number(auctionForm.buyNowPrice) : undefined,
        gelRate: auctionForm.gelRate ? Number(auctionForm.gelRate) : undefined,
        startsAt: new Date(auctionForm.startsAt).toISOString(),
        endsAt: new Date(auctionForm.endsAt).toISOString(),
      });
      setAuctionCreated(auction.id);
      setVehicleId("");
      setPhotos([]);
      await Promise.all([loadManagedAuctions(), loadAvailableVehicles()]);
    } catch (err) {
      setAuctionError(errorMessage(err));
    }
  }

  async function handleDeposit(userId: string) {
    const amount = Number(depositInputs[userId]);
    if (!Number.isFinite(amount) || amount <= 0) {
      setUsersError(t("team.enterValidDeposit"));
      return;
    }
    try {
      await api.post(`/admin/users/${userId}/deposit`, { amount });
      setDepositInputs((d) => ({ ...d, [userId]: "" }));
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
    <div className="space-y-6">
      <h1 className="font-display text-3xl font-bold tracking-wide">{t("team.title")}</h1>

      <section className={sectionClass}>
        <h2 className="font-display mb-5 text-xl font-bold">{t("team.newListingTitle")}</h2>

        <Step number={1} title={t("team.step1Title")}>
          <form onSubmit={handleCreateVehicle} className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <input
              placeholder={t("team.make")}
              value={vehicleForm.make}
              onChange={(e) => setVehicleForm({ ...vehicleForm, make: e.target.value })}
              required
              className={inputClass}
            />
            <input
              placeholder={t("team.model")}
              value={vehicleForm.model}
              onChange={(e) => setVehicleForm({ ...vehicleForm, model: e.target.value })}
              required
              className={inputClass}
            />
            <input
              placeholder={t("team.year")}
              type="number"
              value={vehicleForm.year}
              onChange={(e) => setVehicleForm({ ...vehicleForm, year: e.target.value })}
              required
              className={inputClass}
            />
            <button type="submit" className={buttonClass}>
              {t("team.createVehicle")}
            </button>
          </form>
          {vehicleError && <p className="mt-2 text-sm text-brand">{vehicleError}</p>}
          {vehicleId && (
            <p className="mt-2 text-xs text-ink-faint">
              {t("team.vehicleIdLabel")}: <span className="font-mono">{vehicleId}</span>
            </p>
          )}
        </Step>

      {vehicleId && (
        <Step number={2} title={t("team.step1bTitle")}>
          <div className="mb-3 flex flex-wrap gap-2">
            {photos.map((p, i) => (
              <div key={p.id} className="group relative h-20 w-28 overflow-hidden rounded border border-border">
                <img src={p.url} alt="" className="h-full w-full object-cover" />
                {i === 0 ? (
                  <span className="absolute bottom-0 left-0 rounded-tr bg-brand px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                    {t("team.coverPhoto")}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={async () => {
                      await api.post(`/vehicles/${vehicleId}/photos/${p.id}/primary`);
                      await loadPhotos(vehicleId);
                    }}
                    className="absolute bottom-0 left-0 rounded-tr bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 transition group-hover:opacity-100"
                  >
                    {t("team.makeCoverPhoto")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={async () => {
                    await api.del(`/vehicles/${vehicleId}/photos/${p.id}`);
                    await loadPhotos(vehicleId);
                  }}
                  className="absolute right-0 top-0 rounded-bl bg-black/70 px-1.5 text-xs text-white opacity-0 transition group-hover:opacity-100"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <label className="inline-block cursor-pointer rounded border border-dashed border-border px-4 py-2 text-sm text-ink-muted hover:border-brand hover:text-ink">
            {uploading ? t("common.uploading") : t("team.addPhoto")}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={handlePhotoSelect}
              disabled={uploading}
            />
          </label>
          {photoError && <p className="mt-2 text-sm text-brand">{photoError}</p>}
        </Step>
      )}

        <Step number={3} title={t("team.step2Title")} last>
        <form onSubmit={handleCreateAuction} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={`${labelClass} sm:col-span-2`}>
            <span className={labelTextClass}>{t("team.vehicleIdLabel")}</span>
            <select
              value={vehicleId}
              onChange={(e) => {
                const id = e.target.value;
                setVehicleId(id);
                if (id) loadPhotos(id);
                else setPhotos([]);
              }}
              required
              className={inputClass}
            >
              <option value="" disabled>
                {t("team.vehiclePickerPlaceholder")}
              </option>
              {vehicleId && !availableVehicles?.some((v) => v.id === vehicleId) && (
                // The vehicle just created in step 1 hasn't round-tripped
                // through /vehicles/available yet in this render — keep it
                // selectable so the happy path (create → pick it) doesn't
                // silently lose the selection while that request is in flight.
                <option value={vehicleId}>{t("team.vehicleJustCreated")}</option>
              )}
              {availableVehicles?.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.year} {v.make} {v.model}
                </option>
              ))}
            </select>
            {availableVehicles?.length === 0 && !vehicleId && (
              <p className="mt-1 text-xs text-ink-faint">{t("team.noVehiclesAvailable")}</p>
            )}
          </label>
          <label className={labelClass}>
            <span className={labelTextClass}>{t("team.startingPrice")}</span>
            <input
              type="number"
              value={auctionForm.startingPrice}
              onChange={(e) => setAuctionForm({ ...auctionForm, startingPrice: e.target.value })}
              required
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            <span className={labelTextClass}>{t("team.reservePrice")}</span>
            <input
              type="number"
              value={auctionForm.reservePrice}
              onChange={(e) => setAuctionForm({ ...auctionForm, reservePrice: e.target.value })}
              required
              className={inputClass}
            />
          </label>
          <label className={`${labelClass} sm:col-span-2`}>
            <span className={labelTextClass}>{t("team.buyNowPrice")}</span>
            <input
              type="number"
              value={auctionForm.buyNowPrice}
              onChange={(e) => setAuctionForm({ ...auctionForm, buyNowPrice: e.target.value })}
              placeholder={t("team.leaveBlankToDisable")}
              className={inputClass}
            />
          </label>
          <label className={`${labelClass} sm:col-span-2`}>
            <span className={labelTextClass}>{t("team.gelRateLabel")}</span>
            <input
              type="number"
              step="0.0001"
              value={auctionForm.gelRate}
              onChange={(e) => setAuctionForm({ ...auctionForm, gelRate: e.target.value })}
              placeholder={t("team.gelRatePlaceholder")}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            <span className={labelTextClass}>{t("team.startsAt")}</span>
            <input
              type="datetime-local"
              value={auctionForm.startsAt}
              onChange={(e) => setAuctionForm({ ...auctionForm, startsAt: e.target.value })}
              required
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            <span className={labelTextClass}>{t("team.endsAt")}</span>
            <input
              type="datetime-local"
              value={auctionForm.endsAt}
              onChange={(e) => setAuctionForm({ ...auctionForm, endsAt: e.target.value })}
              required
              className={inputClass}
            />
          </label>
          <button type="submit" className={`${buttonClass} sm:col-span-2`}>
            {t("team.createAuction")}
          </button>
        </form>
        {auctionError && <p className="mt-2 text-sm text-brand">{auctionError}</p>}
        {auctionCreated && (
          <p className="mt-2 text-sm text-live">{t("team.auctionCreated", { id: auctionCreated })}</p>
        )}
        </Step>
      </section>

      <h2 className="font-display pt-2 text-xl font-bold text-ink-muted">{t("team.ongoingTitle")}</h2>

      <section className={sectionClass}>
        <h3 className="font-display mb-4 text-lg font-semibold">{t("team.manageAuctionsTitle")}</h3>
        {managedError && <p className="text-sm text-brand">{managedError}</p>}
        {actionError && <p className="mb-2 text-sm text-brand">{actionError}</p>}
        {!managedAuctions ? (
          <p className="text-sm text-ink-muted">{t("common.loading")}</p>
        ) : managedAuctions.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("team.noAuctionsYet")}</p>
        ) : (
          <div className="space-y-2">
            {managedAuctions.map(({ auction, vehicle }) => (
              <div key={auction.id} className="rounded border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : auction.vehicle_id}
                    </span>
                    <StatusBadge status={auction.status} />
                  </div>
                  <div className="flex items-center gap-3 text-sm text-ink-muted">
                    <span>{gel(auction.current_price)}</span>
                    {auction.reserve_price && (
                      <span
                        className={
                          Number(auction.current_price) >= Number(auction.reserve_price)
                            ? "text-live"
                            : "text-warn"
                        }
                      >
                        {Number(auction.current_price) >= Number(auction.reserve_price)
                          ? t("team.reserveMet")
                          : t("team.reserveNotMet")}
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {auction.status === "live" && (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          confirm(t("team.confirmCancel")) &&
                          runAuctionAction(() => api.post(`/auctions/${auction.id}/cancel`))
                        }
                        className="rounded border border-border px-3 py-1 text-xs font-medium hover:border-brand"
                      >
                        {t("team.actionCancel")}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          confirm(t("team.confirmVoidLastBid")) &&
                          runAuctionAction(() => api.post(`/auctions/${auction.id}/void-last-bid`))
                        }
                        className="rounded border border-border px-3 py-1 text-xs font-medium hover:border-brand"
                      >
                        {t("team.actionVoidLastBid")}
                      </button>
                    </>
                  )}
                  {auction.status === "pending_seller" && (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          runAuctionAction(() => api.post(`/auctions/${auction.id}/accept`))
                        }
                        className="rounded bg-brand px-3 py-1 text-xs font-semibold text-white hover:bg-brand-hover"
                      >
                        {t("team.actionAccept")}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          confirm(t("team.confirmDecline")) &&
                          runAuctionAction(() => api.post(`/auctions/${auction.id}/decline`))
                        }
                        className="rounded border border-border px-3 py-1 text-xs font-medium hover:border-brand"
                      >
                        {t("team.actionDecline")}
                      </button>
                    </>
                  )}
                  {auction.status === "sold" && (
                    <span className="inline-flex items-center gap-1.5">
                      <input
                        placeholder={t("team.reassignPlaceholder")}
                        value={reassignInputs[auction.id] ?? ""}
                        onChange={(e) =>
                          setReassignInputs((r) => ({ ...r, [auction.id]: e.target.value }))
                        }
                        className="w-64 rounded border border-border bg-bg px-2 py-1 text-xs text-ink outline-none focus:border-brand"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const soldTo = reassignInputs[auction.id]?.trim();
                          if (!soldTo) return;
                          runAuctionAction(() =>
                            api.post(`/admin/auctions/${auction.id}/reassign-sale`, { soldTo }),
                          );
                        }}
                        className="rounded border border-border px-3 py-1 text-xs font-medium hover:border-brand"
                      >
                        {t("team.actionReassign")}
                      </button>
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => toggleHistory(auction.id)}
                    className="ml-auto text-xs font-medium text-ink-faint underline decoration-dotted hover:text-ink-muted"
                  >
                    {openHistory === auction.id ? t("team.actionHideHistory") : t("team.actionViewHistory")}
                  </button>
                </div>

                {openHistory === auction.id && (
                  <div className="mt-2 border-t border-border pt-2 text-xs text-ink-muted">
                    {!history[auction.id] ? (
                      <p>{t("common.loading")}</p>
                    ) : history[auction.id]!.length === 0 ? (
                      <p>{t("team.historyEmpty")}</p>
                    ) : (
                      <ul className="space-y-1">
                        {history[auction.id]!.map((e) => (
                          <li key={e.id}>
                            {new Date(e.occurred_at).toLocaleString()} — {t(`team.event.${e.event_type}`)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={sectionClass}>
        <h3 className="font-display mb-4 text-lg font-semibold">{t("team.buyersAwaitingVetting")}</h3>
        {usersError && <p className="text-sm text-brand">{usersError}</p>}
        {!users ? (
          <p className="text-sm text-ink-muted">{t("common.loading")}</p>
        ) : users.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("team.nobodyWaiting")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-ink-muted">
                <th className="py-2 font-medium">{t("team.colName")}</th>
                <th className="py-2 font-medium">{t("team.colEmail")}</th>
                <th className="py-2 font-medium">{t("team.colDeposit")}</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-border last:border-0">
                  <td className="py-2">{u.fullName}</td>
                  <td className="py-2 text-ink-muted">{u.email}</td>
                  <td className="py-2">
                    {u.depositReceivedAt
                      ? t("team.depositReceived", { amount: gel(u.depositAmount!) })
                      : t("team.depositNone")}
                  </td>
                  <td className="py-2 text-right">
                    {!u.depositReceivedAt && (
                      <span className="inline-flex items-center gap-1.5">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder={t("team.depositAmountPlaceholder")}
                          value={depositInputs[u.id] ?? ""}
                          onChange={(e) =>
                            setDepositInputs((d) => ({ ...d, [u.id]: e.target.value }))
                          }
                          className="w-24 rounded border border-border bg-bg px-2 py-1 text-xs text-ink outline-none focus:border-brand"
                        />
                        <button
                          type="button"
                          onClick={() => handleDeposit(u.id)}
                          className="rounded border border-border px-3 py-1 text-xs font-medium hover:border-brand"
                        >
                          {t("team.recordDeposit")}
                        </button>
                      </span>
                    )}
                    {u.depositReceivedAt && (
                      <button
                        type="button"
                        onClick={() => handleEnableBidding(u.id)}
                        className="rounded bg-brand px-3 py-1 text-xs font-semibold text-white hover:bg-brand-hover"
                      >
                        {t("team.enableBidding")}
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
