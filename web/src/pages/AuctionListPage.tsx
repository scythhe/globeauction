import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Auction, type Vehicle, type VehiclePhoto } from "../api.ts";
import { errorMessage } from "../AuthContext.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { CarIcon, ClockIcon, HammerIcon, ShieldCheckIcon } from "../components/icons.tsx";
import { AnimatedPrice } from "../components/AnimatedPrice.tsx";
import { CountdownTimer } from "../components/CountdownTimer.tsx";
import { gel, usdEquivalent } from "../format.ts";
import { usePolling } from "../usePolling.ts";
import { useTranslation } from "../i18n/index.tsx";

interface Row {
  auction: Auction;
  vehicle: Vehicle | null;
  photo: VehiclePhoto | null;
}

export function AuctionListPage({ onSelect }: { onSelect: (auctionId: string) => void }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const auctions = await api.get<Auction[]>("/auctions");
      const withVehicles = await Promise.all(
        auctions.map(async (auction) => {
          try {
            const [vehicle, photos] = await Promise.all([
              api.get<Vehicle>(`/vehicles/${auction.vehicle_id}`),
              api.get<VehiclePhoto[]>(`/vehicles/${auction.vehicle_id}/photos`),
            ]);
            return { auction, vehicle, photo: photos[0] ?? null };
          } catch {
            return { auction, vehicle: null, photo: null };
          }
        }),
      );
      setRows(withVehicles);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  usePolling(load, 5000, true);

  if (error) return <p className="text-brand">{error}</p>;
  if (!rows) return <ListSkeleton />;

  // Real, computed numbers — not decorative placeholders.
  const liveCount = rows.filter((r) => r.auction.status === "live").length;
  const soldCount = rows.filter((r) => r.auction.status === "sold").length;
  const totalBidVolume = rows
    .filter((r) => r.auction.status === "sold")
    .reduce((sum, r) => sum + Number(r.auction.final_price ?? 0), 0);

  return (
    <div>
      <Hero liveCount={liveCount} soldCount={soldCount} totalBidVolume={totalBidVolume} />

      {rows.length === 0 ? (
        <p className="text-ink-muted">{t("list.noAuctions")}</p>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(({ auction, vehicle, photo }) => (
            <button
              key={auction.id}
              type="button"
              onClick={() => onSelect(auction.id)}
              className={[
                "group overflow-hidden rounded-lg border bg-surface text-left shadow-lg transition hover:-translate-y-0.5 hover:border-brand/60 hover:shadow-brand/10",
                // Live cards are the only ones a visitor can still act on
                // — a faint green tint on the border/shadow marks that at
                // a glance, instead of every card (live, sold, cancelled)
                // sharing identical chrome and leaving the status badge
                // as the only signal.
                auction.status === "live"
                  ? "border-live/30 shadow-live/5"
                  : "border-border",
              ].join(" ")}
            >
              <div className="relative aspect-video w-full overflow-hidden bg-gradient-to-br from-surface-hover to-black">
                {photo ? (
                  <img
                    src={photo.url}
                    alt=""
                    className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                  />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-ink-faint">
                    <CarIcon className="h-10 w-10" />
                    <span className="text-xs">{t("list.noPhotoYet")}</span>
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                <div className="absolute left-2 top-2">
                  <StatusBadge status={auction.status} />
                </div>
                {auction.buy_now_price && !auction.high_bid_id && auction.status === "live" && (
                  <div className="absolute right-2 top-2 rounded bg-black/70 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-live">
                    {t("list.buyNowBadge")}
                  </div>
                )}
                {auction.status === "live" && (
                  <div className="absolute bottom-2 right-2 rounded bg-black/70 px-2 py-1">
                    <CountdownTimer
                      endsAt={auction.ends_at}
                      live
                      size="sm"
                      bonusExtensionUsed={auction.bonus_extension_used}
                      softCloseExtension={auction.soft_close_extension}
                    />
                  </div>
                )}
              </div>
              <div className="p-4">
                <h3 className="font-display truncate text-lg font-semibold text-ink">
                  {vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : t("list.vehicleFallback")}
                </h3>
                <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
                  <span className="text-xs uppercase tracking-wide text-ink-muted">{t("list.currentBid")}</span>
                  <div className="text-right">
                    <div className="text-xl font-bold text-brand">
                      <AnimatedPrice value={auction.current_price} />
                    </div>
                    {usdEquivalent(auction.current_price, auction.gel_rate) && (
                      <div className="text-xs text-ink-faint">
                        {usdEquivalent(auction.current_price, auction.gel_rate)}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Hero({
  liveCount,
  soldCount,
  totalBidVolume,
}: {
  liveCount: number;
  soldCount: number;
  totalBidVolume: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative mb-8 overflow-hidden rounded-xl border border-border bg-surface p-8">
      {/* Decorative gradient glow — CSS only, no external imagery to source. */}
      <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-brand/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-24 h-64 w-64 rounded-full bg-brand-dim/30 blur-3xl" />

      <div className="relative">
        <h1 className="font-display text-3xl font-bold leading-tight tracking-wide sm:text-4xl">
          {t("hero.titleLine1")}
          <br />
          <span className="text-brand">{t("hero.titleLine2")}</span>
        </h1>
        <p className="mt-3 max-w-md text-sm text-ink-muted">{t("hero.subtitle")}</p>

        <div className="mt-6 grid grid-cols-3 gap-4 border-t border-border pt-6 sm:max-w-md">
          <Stat icon={<HammerIcon className="h-5 w-5" />} label={t("hero.liveNow")} value={String(liveCount)} />
          <Stat icon={<ShieldCheckIcon className="h-5 w-5" />} label={t("hero.sold")} value={String(soldCount)} />
          <Stat
            icon={<ClockIcon className="h-5 w-5" />}
            label={t("hero.totalSoldVolume")}
            value={totalBidVolume > 0 ? gel(totalBidVolume) : "—"}
          />
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-brand">{icon}</div>
      <div className="font-display mt-1 text-xl font-bold">{value}</div>
      <div className="text-xs uppercase tracking-wide text-ink-faint">{label}</div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div>
      <div className="mb-8 h-48 animate-pulse rounded-xl border border-border bg-surface" />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="animate-pulse overflow-hidden rounded-lg border border-border bg-surface">
            <div className="aspect-video w-full bg-surface-hover" />
            <div className="space-y-2 p-4">
              <div className="h-4 w-2/3 rounded bg-surface-hover" />
              <div className="h-4 w-1/3 rounded bg-surface-hover" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
