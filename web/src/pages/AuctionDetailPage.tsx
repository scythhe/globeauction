import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type Auction, type Bid, type Vehicle, type VehiclePhoto } from "../api.ts";
import { useAuth, errorMessage } from "../AuthContext.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { CountdownTimer } from "../components/CountdownTimer.tsx";
import { AnimatedPrice } from "../components/AnimatedPrice.tsx";
import { CarIcon, FuelIcon, GaugeIcon, GearIcon } from "../components/icons.tsx";
import { addGel, gel, subtractGel, usdEquivalent } from "../format.ts";
import { usePolling } from "../usePolling.ts";
import { useTranslation } from "../i18n/index.tsx";

export function AuctionDetailPage({
  auctionId,
  onBack,
}: {
  auctionId: string;
  onBack: () => void;
}) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [auction, setAuction] = useState<Auction | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [photos, setPhotos] = useState<VehiclePhoto[]>([]);
  const [activePhoto, setActivePhoto] = useState(0);
  const [bids, setBids] = useState<Bid[]>([]);
  // The amount the stepper below is currently set to — not free-typed.
  // Copart's own bid entry works the same way (confirmed against real
  // screenshots, not assumed): stepping by the increment is what actually
  // prevents the fat-finger-typo class of mistake void-last-bid exists to
  // clean up after, not just a validation message after the fact.
  const [stepperValue, setStepperValue] = useState<string | null>(null);
  // Monster Bid — Copart's real term: type an exact amount and jump
  // straight to it, bypassing the stepper's increment-only entry. Same
  // POST /bids endpoint as Quick Bid underneath (same validation, same
  // bid_limit, same void-last-bid eligibility) — the only thing that's
  // actually different is this UI lets you type a number instead of
  // stepping to it, plus a stronger confirmation since it's a bigger,
  // more deliberate jump.
  const [monsterBidOpen, setMonsterBidOpen] = useState(false);
  const [monsterBidValue, setMonsterBidValue] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<Auction | null> => {
    try {
      const a = await api.get<Auction>(`/auctions/${auctionId}`);
      setAuction(a);
      const [v, p, b] = await Promise.all([
        api.get<Vehicle>(`/vehicles/${a.vehicle_id}`),
        api.get<VehiclePhoto[]>(`/vehicles/${a.vehicle_id}/photos`),
        api.get<Bid[]>(`/auctions/${auctionId}/bids`),
      ]);
      setVehicle(v);
      setPhotos(p);
      setBids(b);
      return a;
    } catch (err) {
      setLoadError(errorMessage(err));
      return null;
    }
  }, [auctionId]);

  useEffect(() => {
    load();
  }, [load]);

  // The heart of the "live bid war" feel: this is what turns proxy bidding
  // (invisible unless you refresh) into something that looks and feels
  // live, without touching place_bid() at all.
  usePolling(load, 3000, auction?.status === "live");

  // Keeps the stepper's floor in sync with the live minimum. Only ever
  // moves it *up* — if someone else's bid raises nextMinimumBid past
  // wherever the stepper currently sits, that number is no longer a valid
  // bid, so it has to follow; but if the bidder has already dialed the
  // stepper above the new minimum, leave their choice alone rather than
  // resetting it back down on every 3-second poll.
  useEffect(() => {
    if (!auction) return;
    setStepperValue((current) =>
      current === null || Number(current) < Number(auction.nextMinimumBid)
        ? auction.nextMinimumBid
        : current,
    );
  }, [auction?.nextMinimumBid]);

  // amount stays a string end-to-end: the backend validates and stores it
  // as Postgres `numeric` directly, and round-tripping it through a JS
  // number here first could misrepresent the exact figure the user typed
  // at binary-floating-point boundaries (CLAUDE.md hard rule #1).
  async function submitBid(amount: string) {
    setActionError(null);
    setSubmitting(true);
    try {
      await api.post<Bid>(`/auctions/${auctionId}/bids`, { max_amount: amount });
    } catch (err) {
      // Only the POST itself failing means the bid didn't happen. Anything
      // that goes wrong after this point (refreshing the displayed state)
      // must never be reported as "your bid failed" — it wasn't the bid
      // that failed.
      if (err instanceof ApiError && err.code === "bid_too_low") {
        setActionError(t("detail.tooLowMinimum", { amount: err.extra.minimum as string }));
      } else {
        setActionError(errorMessage(err));
      }
      setSubmitting(false);
      return;
    }
    // No one-off "here's what just happened" message — the persistent
    // WINNING/OUTBID badge below (derived from bids + high_bid_id on every
    // load) already reflects the true state at all times, matching how
    // Copart's own bidding screen shows an always-current status rather
    // than a toast that appears once and vanishes.
    await load();
    setSubmitting(false);
  }

  function stepUp() {
    if (!auction || stepperValue === null) return;
    setStepperValue(addGel(stepperValue, auction.bidIncrement));
  }

  function stepDown() {
    if (!auction || stepperValue === null) return;
    const next = subtractGel(stepperValue, auction.bidIncrement);
    // Never below the actual minimum place_bid() will accept.
    setStepperValue(Number(next) < Number(auction.nextMinimumBid) ? auction.nextMinimumBid : next);
  }

  async function handleMonsterBid() {
    const trimmed = monsterBidValue.trim();
    // Client-side check only, for immediate feedback — the actual
    // validation (shape, minimum, bid_limit) is the server's, same as
    // every other bid path.
    if (!Number.isFinite(Number(trimmed)) || Number(trimmed) <= 0 || trimmed === "") {
      setActionError(t("detail.enterValidAmount"));
      return;
    }
    if (!confirm(t("detail.monsterBidConfirm", { amount: gel(trimmed) }))) return;
    await submitBid(trimmed);
    setMonsterBidValue("");
    setMonsterBidOpen(false);
  }

  async function handleBuyNow() {
    if (!confirm(t("detail.buyNowConfirm", { price: gel(auction!.buy_now_price!) }))) {
      return;
    }
    setActionError(null);
    setSubmitting(true);
    try {
      await api.post(`/auctions/${auctionId}/buy-now`);
    } catch (err) {
      // Same principle as submitBid: only the POST failing means the
      // purchase didn't happen. A hiccup in the refresh afterward must
      // never be reported as "the purchase failed."
      setActionError(errorMessage(err));
      setSubmitting(false);
      return;
    }
    await load();
    setSubmitting(false);
  }

  if (loadError) return <p className="text-brand">{loadError}</p>;
  if (!auction || !vehicle) return <DetailSkeleton />;

  const canBid = user?.role === "buyer" || user?.role === "dealer";
  const isLive = auction.status === "live";
  const buyNowAvailable = isLive && auction.buy_now_price && !auction.high_bid_id;
  const currentPhoto = photos[activePhoto];

  // Persistent, always-current status — recomputed on every load/poll, not
  // a one-off message shown right after clicking. This is the actual
  // Copart pattern (a standing "Outbid" label on the bidding screen, not a
  // toast), and it's what makes "I raised my own max and the price didn't
  // move" self-explanatory: you just look at this and see you're still
  // winning, no separate explanation needed.
  const myBid = bids.find((b) => b.bidder_id === user?.id);
  const highBid = bids.find((b) => b.id === auction.high_bid_id);
  const myStatus: "winning" | "outbid" | null = !myBid
    ? null
    : highBid?.bidder_id === user?.id
      ? "winning"
      : "outbid";

  return (
    <div>
      <button type="button" onClick={onBack} className="mb-4 text-sm text-ink-muted hover:text-ink">
        {t("detail.back")}
      </button>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">
        {/* Photo gallery */}
        <div className="lg:col-span-3">
          <div className="aspect-video w-full overflow-hidden rounded-lg border border-border bg-black">
            {currentPhoto ? (
              <img src={currentPhoto.url} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-surface-hover to-black text-ink-faint">
                <CarIcon className="h-14 w-14" />
                <span className="text-sm">{t("detail.noPhotosYet")}</span>
              </div>
            )}
          </div>
          {photos.length > 1 && (
            <div className="mt-2 flex gap-2 overflow-x-auto">
              {photos.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setActivePhoto(i)}
                  className={`h-16 w-24 shrink-0 overflow-hidden rounded border-2 ${
                    i === activePhoto ? "border-brand" : "border-border"
                  }`}
                >
                  <img src={p.url} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}

          <div className="mt-6">
            <h1 className="font-display text-2xl font-bold">
              {vehicle.year} {vehicle.make} {vehicle.model}
            </h1>
            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
              {vehicle.body_style && <Spec label={t("spec.bodyStyle")} value={vehicle.body_style} />}
              {vehicle.color && <Spec label={t("spec.color")} value={vehicle.color} />}
              {vehicle.mileage !== null && (
                <Spec
                  icon={<GaugeIcon className="h-3.5 w-3.5" />}
                  label={t("spec.mileage")}
                  value={`${vehicle.mileage.toLocaleString()} ${vehicle.mileage_unit}${
                    vehicle.odometer_accurate === false ? t("spec.mileageUnconfirmed") : ""
                  }`}
                />
              )}
              {vehicle.engine_volume && (
                <Spec label={t("spec.engine")} value={`${vehicle.engine_volume}L${vehicle.cylinders ? ` / ${vehicle.cylinders}cyl` : ""}`} />
              )}
              {vehicle.fuel_type && (
                <Spec icon={<FuelIcon className="h-3.5 w-3.5" />} label={t("spec.fuel")} value={vehicle.fuel_type} />
              )}
              {vehicle.transmission && (
                <Spec icon={<GearIcon className="h-3.5 w-3.5" />} label={t("spec.transmission")} value={vehicle.transmission} />
              )}
              {vehicle.drive_type && <Spec label={t("spec.driveType")} value={vehicle.drive_type} />}
              {vehicle.doors && <Spec label={t("spec.doors")} value={vehicle.doors} />}
              {vehicle.steering_side && <Spec label={t("spec.steering")} value={vehicle.steering_side} />}
              {vehicle.interior_color && <Spec label={t("spec.interior")} value={vehicle.interior_color} />}
              {vehicle.vin && <Spec label={t("spec.vin")} value={vehicle.vin} />}
              {vehicle.location && <Spec label={t("spec.location")} value={vehicle.location} />}
              <Spec label={t("spec.customs")} value={vehicle.customs_cleared ? t("spec.customsCleared") : t("spec.customsNotCleared")} />
              {vehicle.tech_inspection !== null && (
                <Spec label={t("spec.techInspection")} value={vehicle.tech_inspection ? t("spec.techPassed") : t("spec.techNotPassed")} />
              )}
              {/* Salvage-lot fields — only meaningful once phase 2 lists
                  damaged vehicles; phase-1 retail stock leaves these
                  null/"unknown", so they simply don't render here yet. */}
              {vehicle.damage_primary && <Spec label={t("spec.damage")} value={vehicle.damage_primary} />}
              {vehicle.run !== "unknown" && <Spec label={t("spec.runsAndDrives")} value={vehicle.run.replace(/_/g, " ")} />}
              {vehicle.title !== "unknown" && <Spec label={t("spec.title")} value={vehicle.title.replace(/_/g, " ")} />}
              {vehicle.has_keys !== null && (
                <Spec label={t("spec.keys")} value={vehicle.has_keys ? t("spec.keysPresent") : t("spec.keysMissing")} />
              )}
            </dl>
            {vehicle.features.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {vehicle.features.map((f) => (
                  <span
                    key={f}
                    className="rounded-full border border-border px-2 py-0.5 text-xs text-ink-muted"
                  >
                    {f.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            )}
            {vehicle.description && (
              <p className="mt-4 text-sm leading-relaxed text-ink-muted">{vehicle.description}</p>
            )}
          </div>

        </div>

        {/* Bid panel */}
        <div className="lg:col-span-2">
          <div className="sticky top-20 rounded-lg border border-border bg-surface p-5 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <StatusBadge status={auction.status} />
              <CountdownTimer
                endsAt={auction.ends_at}
                live={isLive}
                bonusExtensionUsed={auction.bonus_extension_used}
                softCloseExtension={auction.soft_close_extension}
              />
            </div>

            <div className="mb-1 text-xs uppercase tracking-wide text-ink-muted">{t("detail.currentBid")}</div>
            <div className="font-display text-4xl font-bold text-brand">
              <AnimatedPrice value={auction.current_price} />
            </div>
            {usdEquivalent(auction.current_price, auction.gel_rate) && (
              <div className="mb-1 text-sm text-ink-faint">
                {usdEquivalent(auction.current_price, auction.gel_rate)}
              </div>
            )}

            {/* Persistent status — always visible, always current. This is
                what Copart actually shows (a standing "Outbid" label), not
                a message that flashes once after you click and disappears. */}
            {myStatus === "winning" && (
              <div className="mb-3 inline-flex items-center gap-1.5 rounded bg-live/15 px-2 py-1 text-xs font-bold uppercase tracking-wider text-live">
                ● {t("detail.winning")}
              </div>
            )}
            {myStatus === "outbid" && (
              <div className="mb-3 inline-flex items-center gap-1.5 rounded bg-brand/15 px-2 py-1 text-xs font-bold uppercase tracking-wider text-brand">
                ● {t("detail.outbid")}
              </div>
            )}

            {auction.reserveMet !== undefined && (
              <div
                className={`mb-3 rounded px-2 py-1 text-xs font-semibold uppercase tracking-wide ${
                  auction.reserveMet ? "bg-live/15 text-live" : "bg-warn/15 text-warn"
                }`}
              >
                {auction.reserveMet ? t("detail.reserveMet") : t("detail.reserveNotMet")}
              </div>
            )}
            {auction.reserve_price && (
              <div className="mb-3 text-xs text-ink-faint">
                {t("detail.reserveTeamView", { price: gel(auction.reserve_price) })}
              </div>
            )}

            {/* Minimalistic on purpose — a single beat, not a full
                celebration screen — but it has to actually say "won,"
                not just leave the win to be inferred from the status
                badge like everything else here. */}
            {auction.status === "sold" && auction.sold_to === user?.id && (
              <div className="animate-win-pop mb-3 rounded-lg border border-live bg-live/10 px-4 py-3 text-center">
                <div className="font-display text-2xl font-bold text-live">{t("detail.won")}</div>
              </div>
            )}

            {auction.status === "sold" && (
              <p className="mb-3 text-sm text-ink-muted">
                {t("detail.soldFor")}{" "}
                <span className="font-semibold text-ink">{gel(auction.final_price!)}</span>
              </p>
            )}

            {isLive && buyNowAvailable && canBid && user?.canBid && (
              <button
                type="button"
                onClick={handleBuyNow}
                disabled={submitting}
                className="mb-3 w-full rounded bg-live py-2.5 font-bold uppercase tracking-wide text-white shadow-[0_0_16px_-4px_theme(colors.live)] transition hover:brightness-110 disabled:opacity-50"
              >
                {t("detail.buyNowButton", { price: gel(auction.buy_now_price!) })}
                {usdEquivalent(auction.buy_now_price!, auction.gel_rate) &&
                  ` (${usdEquivalent(auction.buy_now_price!, auction.gel_rate)})`}
              </button>
            )}

            {isLive && canBid && user?.canBid && stepperValue !== null && (
              <div>
                {/* Max Bid — Copart's own term for proxy bidding: you name
                    the most you'll pay, the system bids for you, only as
                    much as needed to stay ahead, up to that number.
                    Stepped by the increment, not typed — verified against
                    Copart's own bid entry (no free-text amount field
                    there either), and it's what actually prevents the
                    fat-finger-typo class of mistake at entry time, rather
                    than just catching it after with void-last-bid. */}
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-muted">
                  {t("detail.maxBidLabel")}
                </label>
                <p className="mb-2 text-xs text-ink-faint">{t("detail.maxBidExplainer")}</p>
                <div className="flex items-stretch gap-2">
                  <div className="flex items-center rounded border border-border bg-bg">
                    <button
                      type="button"
                      onClick={stepDown}
                      disabled={submitting || stepperValue === auction.nextMinimumBid}
                      aria-label={t("detail.stepDown")}
                      className="px-3 py-2 text-lg font-bold text-ink-muted transition hover:text-ink disabled:opacity-30"
                    >
                      −
                    </button>
                    <span className="min-w-[7ch] flex-1 px-1 text-center font-mono text-ink">
                      {gel(stepperValue)}
                    </span>
                    <button
                      type="button"
                      onClick={stepUp}
                      disabled={submitting}
                      aria-label={t("detail.stepUp")}
                      className="px-3 py-2 text-lg font-bold text-ink-muted transition hover:text-ink disabled:opacity-30"
                    >
                      +
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => submitBid(stepperValue)}
                    disabled={submitting}
                    className="shrink-0 rounded bg-brand px-4 py-2 text-sm font-bold text-white shadow-[0_0_16px_-4px_var(--color-brand)] transition hover:bg-brand-hover disabled:opacity-50"
                  >
                    {t("detail.placeMaxBid")}
                  </button>
                </div>

                {/* Monster Bid — a deliberately lower-key entry point than
                    Quick Bid, matching Copart's own treatment of it as a
                    power feature, not the default path. */}
                {monsterBidOpen ? (
                  <div className="mt-3 rounded border border-border p-3">
                    <p className="mb-2 text-xs text-ink-faint">{t("detail.monsterBidExplainer")}</p>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        value={monsterBidValue}
                        onChange={(e) => setMonsterBidValue(e.target.value)}
                        placeholder={t("detail.monsterBidPlaceholder")}
                        min={0}
                        className="w-full rounded border border-border bg-bg px-3 py-2 text-ink outline-none focus:border-brand"
                      />
                      <button
                        type="button"
                        onClick={handleMonsterBid}
                        disabled={submitting}
                        className="shrink-0 rounded border border-brand px-3 py-2 text-sm font-bold text-brand transition hover:bg-brand hover:text-white disabled:opacity-50"
                      >
                        {t("detail.monsterBidSubmit")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setMonsterBidOpen(true)}
                    disabled={submitting}
                    className="mt-2 text-xs font-medium text-ink-faint underline decoration-dotted transition hover:text-ink-muted"
                  >
                    {t("detail.monsterBidToggle")}
                  </button>
                )}
              </div>
            )}

            {actionError && <p className="mt-2 text-sm text-brand">{actionError}</p>}

            {isLive && canBid && !user?.canBid && (
              <p className="mt-2 text-sm italic text-ink-muted">{t("detail.biddingNotEnabled")}</p>
            )}
            {isLive && !canBid && user && (
              <p className="mt-2 text-sm italic text-ink-muted">{t("detail.teamCannotBid")}</p>
            )}
            {isLive && !user && (
              <p className="mt-2 text-sm italic text-ink-muted">{t("detail.logInToBid")}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Spec({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-xs uppercase tracking-wide text-ink-faint">
        {icon}
        {label}
      </dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">
      <div className="animate-pulse lg:col-span-3">
        <div className="aspect-video rounded-lg bg-surface" />
      </div>
      <div className="animate-pulse lg:col-span-2">
        <div className="h-64 rounded-lg bg-surface" />
      </div>
    </div>
  );
}
