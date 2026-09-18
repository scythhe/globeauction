import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { api, type Vehicle, type VehiclePhoto } from "../api.ts";
import { errorMessage } from "../AuthContext.tsx";
import { gel } from "../format.ts";
import { useTranslation } from "../i18n/index.tsx";

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
    <div className="space-y-6">
      <h1 className="font-display text-3xl font-bold tracking-wide">{t("team.title")}</h1>

      <section className={sectionClass}>
        <h3 className="font-display mb-4 text-lg font-semibold">{t("team.step1Title")}</h3>
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
      </section>

      {vehicleId && (
        <section className={sectionClass}>
          <h3 className="font-display mb-4 text-lg font-semibold">{t("team.step1bTitle")}</h3>
          <div className="mb-3 flex flex-wrap gap-2">
            {photos.map((p) => (
              <div key={p.id} className="group relative h-20 w-28 overflow-hidden rounded border border-border">
                <img src={p.url} alt="" className="h-full w-full object-cover" />
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
        </section>
      )}

      <section className={sectionClass}>
        <h3 className="font-display mb-4 text-lg font-semibold">{t("team.step2Title")}</h3>
        <form onSubmit={handleCreateAuction} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={`${labelClass} sm:col-span-2`}>
            <span className={labelTextClass}>{t("team.vehicleIdLabel")}</span>
            <input
              value={vehicleId}
              onChange={(e) => setVehicleId(e.target.value)}
              placeholder={t("team.vehicleIdPlaceholder")}
              required
              className={inputClass}
            />
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
                      <button
                        type="button"
                        onClick={() => handleDeposit(u.id)}
                        className="rounded border border-border px-3 py-1 text-xs font-medium hover:border-brand"
                      >
                        {t("team.recordDeposit")}
                      </button>
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
