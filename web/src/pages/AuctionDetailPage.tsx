import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type Auction, type Bid, type Vehicle, type VehiclePhoto } from "../api.ts";
import { useAuth, errorMessage } from "../AuthContext.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { CountdownTimer } from "../components/CountdownTimer.tsx";
import { AnimatedPrice } from "../components/AnimatedPrice.tsx";
import { CarIcon, FuelIcon, GaugeIcon, GearIcon } from "../components/icons.tsx";
import { addGel, gel, subtractGel, usdEquivalent } from "../format.ts";
import { usePolling } from "../usePolling.ts";
import { useTranslation } from "../i18n/index.tsx";

// Fixed, deliberately coarser than the ordinary bid_increment table —
// Monster Bid (and pre-bidding, which reuses this exact same stepper) is
// meant for a bigger, more decisive jump, not the same fine-grained
// stepping Quick Bid already does.
const BIG_STEP = "100.00";

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
  // Monster Bid — Copart's real term: jump straight to a much bigger
  // amount, bypassing Quick Bid's normal increment-only stepping. It used
  // to be a free-text field; now it's the same stepper interaction as
  // Quick Bid, just with a fixed, coarser step (100 ₾, not the variable
  // bid_increment table) — still bypasses the ordinary increments (that's
  // the whole point), but dialed in rather than typed, so it can't
  // fat-finger a typo any more than Quick Bid can. Same POST /bids
  // endpoint underneath either way (same validation, same bid_limit, same
  // void-last-bid eligibility).
  const [monsterBidOpen, setMonsterBidOpen] = useState(false);
  const [monsterBidValue, setMonsterBidValue] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // "Bid Placed!" — briefly overrides the ring's label (not its color,
  // which already reflects the real outcome) right after a submit, so a
  // bid feels acknowledged instantly instead of just silently updating
  // the same Winning/Outbid text it already showed.
  const [justBidPlaced, setJustBidPlaced] = useState(false);
  const bidPlacedTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  usePolling(load, 3000, auction?.status === "live" || auction?.status === "scheduled");

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

  // Same floor-tracking rule as the Quick Bid stepper above, applied to
  // Monster Bid / pre-bid's own stepper so it always opens on a valid
  // amount — there's no free-text entry left to fall back on if this
  // drifted below the real minimum.
  useEffect(() => {
    if (!auction) return;
    setMonsterBidValue((current) =>
      current === "" || Number(current) < Number(auction.nextMinimumBid)
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
    // The persistent Winning/Outbid ring (derived from bids + high_bid_id
    // on every load) already reflects the true state at all times — this
    // just makes the very next render say "Bid Placed!" for a moment
    // instead of jumping straight to that same standing status with no
    // acknowledgement the click did anything.
    if (bidPlacedTimeout.current) clearTimeout(bidPlacedTimeout.current);
    setJustBidPlaced(true);
    bidPlacedTimeout.current = setTimeout(() => setJustBidPlaced(false), 1500);
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

  function stepBigUp() {
    if (!monsterBidValue) return;
    setMonsterBidValue(addGel(monsterBidValue, BIG_STEP));
  }

  function stepBigDown() {
    if (!auction || !monsterBidValue) return;
    const next = subtractGel(monsterBidValue, BIG_STEP);
    setMonsterBidValue(Number(next) < Number(auction.nextMinimumBid) ? auction.nextMinimumBid : next);
  }

  // No native confirm() dialog here (an unbranded browser popup, jarring
  // mid-flow) — the stepper's own reveal-then-Confirm-button sequence is
  // already the deliberate multi-step flow that used to justify one, and
  // it no longer has free text to double-check the way it once did.
  async function handleMonsterBid() {
    await submitBid(monsterBidValue);
    setMonsterBidOpen(false);
  }

  // Pre-bidding (db/013): a max bid placed before the auction's own
  // starts_at. Same endpoint, same stepper mechanic as Monster Bid (there's
  // no "current price vs. increment" context worth stepping through yet —
  // nothing's live), just without Monster Bid's extra confirmation, since
  // this is the *only* way to bid pre-launch, not a deliberate power-user
  // detour away from a normal default.
  async function handlePreBid() {
    await submitBid(monsterBidValue);
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
  // Pre-bidding (db/013): a scheduled auction can already take a max bid.
  const isScheduled = auction.status === "scheduled";
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

  // The ring only ever appears once you've actually bid — there's no
  // "someone else is currently ahead" neutral state to show otherwise
  // (Copart anonymizes that with a per-bidder country flag; we have no
  // such identity to attribute it to, and showing a stranger's number
  // with nothing to compare it to isn't actually informative here).
  const ringStatus: "winning" | "outbid" | "won" | "lost" | null =
    auction.status === "sold"
      ? auction.sold_to === user?.id
        ? "won"
        : myBid
          ? "lost"
          : null
      : myStatus;
  const ringLabel = justBidPlaced
    ? t("detail.bidPlaced")
    : ringStatus === "winning"
      ? t("detail.winning")
      : ringStatus === "outbid"
        ? t("detail.outbid")
        : ringStatus === "won"
          ? t("detail.won")
          : ringStatus === "lost"
            ? t("detail.outbid")
            : "";

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
            <dl className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
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

        {/* Bid panel — the one box on this page where money actually
            changes hands, so it gets a visual identity the plain
            info/spec panels deliberately don't: a brand-tinted border and
            a top accent bar, instead of the same border-border/bg-surface
            treatment used everywhere else. */}
        <div className="lg:col-span-2">
          <div className="sticky top-20 overflow-hidden rounded-lg border border-brand/25 bg-surface shadow-xl shadow-black/40">
            <div className="h-1 bg-gradient-to-r from-brand via-brand-hover to-brand" />
            <div className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <StatusBadge status={auction.status} />
              {isLive ? (
                <CountdownTimer
                  endsAt={auction.ends_at}
                  live={isLive}
                  bonusExtensionUsed={auction.bonus_extension_used}
                  softCloseExtension={auction.soft_close_extension}
                />
              ) : (
                isScheduled && (
                  // Not the ends_at countdown — that isn't meaningful yet,
                  // and CountdownTimer's own "ended" state is keyed off
                  // `live`, so reusing it here pre-launch would misreport
                  // a scheduled auction as already over.
                  <span className="text-xs text-ink-muted">
                    {t("detail.startsAt", { date: new Date(auction.starts_at).toLocaleString() })}
                  </span>
                )
              )}
            </div>

            {/* The ring only replaces the plain price once you've actually
                bid — Copart shows this ring for every visitor, colored by
                whichever anonymized bidder currently leads, but that relies
                on a per-bidder country-flag identity we don't have. Before
                you've bid, there's nothing personalized to show, so the
                plain current-bid figure stays exactly as it was. */}
            {ringStatus ? (
              <BidStatusRing status={ringStatus} price={auction.current_price} label={ringLabel} />
            ) : (
              <>
                <div className="mb-1 text-xs uppercase tracking-wide text-ink-muted">{t("detail.currentBid")}</div>
                <div className="font-display text-4xl font-bold text-brand">
                  <AnimatedPrice value={auction.current_price} />
                </div>
                {usdEquivalent(auction.current_price, auction.gel_rate) && (
                  <div className="mb-1 text-sm text-ink-faint">
                    {usdEquivalent(auction.current_price, auction.gel_rate)}
                  </div>
                )}
              </>
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
                    <div className="flex items-stretch gap-2">
                      <AmountStepper
                        value={monsterBidValue}
                        onStepDown={stepBigDown}
                        onStepUp={stepBigUp}
                        downDisabled={submitting || monsterBidValue === auction.nextMinimumBid}
                        upDisabled={submitting}
                        stepDownLabel={t("detail.stepDown")}
                        stepUpLabel={t("detail.stepUp")}
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

            {/* Pre-bidding (db/013) — the only bid control before the
                auction actually opens. Reuses Monster Bid's exact stepper
                (fixed ±100 step, no live increment context to step
                through yet) rather than a second, separate input style. */}
            {isScheduled && canBid && user?.canBid && monsterBidValue !== "" && (
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-muted">
                  {t("detail.preBidLabel")}
                </label>
                <p className="mb-2 text-xs text-ink-faint">{t("detail.preBidExplainer")}</p>
                <div className="flex items-stretch gap-2">
                  <AmountStepper
                    value={monsterBidValue}
                    onStepDown={stepBigDown}
                    onStepUp={stepBigUp}
                    downDisabled={submitting || monsterBidValue === auction.nextMinimumBid}
                    upDisabled={submitting}
                    stepDownLabel={t("detail.stepDown")}
                    stepUpLabel={t("detail.stepUp")}
                  />
                  <button
                    type="button"
                    onClick={handlePreBid}
                    disabled={submitting}
                    className="shrink-0 rounded bg-brand px-4 py-2 text-sm font-bold text-white shadow-[0_0_16px_-4px_var(--color-brand)] transition hover:bg-brand-hover disabled:opacity-50"
                  >
                    {t("detail.preBidSubmit")}
                  </button>
                </div>
              </div>
            )}

            {actionError && <p className="mt-2 text-sm text-brand">{actionError}</p>}

            {(isLive || isScheduled) && canBid && !user?.canBid && (
              <p className="mt-2 text-sm italic text-ink-muted">{t("detail.biddingNotEnabled")}</p>
            )}
            {(isLive || isScheduled) && !canBid && user && (
              <p className="mt-2 text-sm italic text-ink-muted">{t("detail.teamCannotBid")}</p>
            )}
            {(isLive || isScheduled) && !user && (
              <p className="mt-2 text-sm italic text-ink-muted">{t("detail.logInToBid")}</p>
            )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Shared by Monster Bid and pre-bidding — both step by a fixed amount
// (BIG_STEP) rather than Quick Bid's variable bid_increment, so they share
// one stepper instead of two near-identical copies of the same markup.
// The circular Winning/Outbid/Won/Outbid-final indicator — replaces the
// plain current-price figure once you've actually bid. "winning"/"outbid"
// are an open ring (auction still live/scheduled, you can still act);
// "won"/"lost" are a solid filled circle with a checkmark (auction over) —
// same distinction Copart's own widget draws between "still in play" and
// "final."
function BidStatusRing({
  status,
  price,
  label,
}: {
  status: "winning" | "outbid" | "won" | "lost";
  price: string;
  label: string;
}) {
  const solid = status === "won" || status === "lost";
  const palette =
    status === "winning"
      ? "border-live bg-live/10 text-live"
      : status === "outbid"
        ? "border-ink-faint bg-surface-hover text-ink-muted"
        : status === "won"
          ? "border-live bg-live text-white"
          : "border-brand bg-brand text-white";

  return (
    <div
      className={[
        // mx-auto: this is the one circular element in an otherwise
        // block-of-text panel — left-flush like the plain price it
        // replaces read as unintentional, not a deliberate focal point.
        "animate-win-pop mx-auto mb-3 flex h-36 w-36 flex-col items-center justify-center rounded-full border-4 px-3 text-center",
        palette,
      ].join(" ")}
    >
      {solid && <span className="text-3xl leading-none">✓</span>}
      {!solid && (
        <span className="font-display text-xl font-bold tabular-nums">{gel(price)}</span>
      )}
      <span
        className={`text-[10px] font-bold uppercase leading-tight tracking-wide ${solid ? "mt-1" : "mt-0.5"}`}
      >
        {label}
      </span>
    </div>
  );
}

function AmountStepper({
  value,
  onStepDown,
  onStepUp,
  downDisabled,
  upDisabled,
  stepDownLabel,
  stepUpLabel,
}: {
  value: string;
  onStepDown: () => void;
  onStepUp: () => void;
  downDisabled?: boolean;
  upDisabled?: boolean;
  stepDownLabel: string;
  stepUpLabel: string;
}) {
  return (
    <div className="flex items-center rounded border border-border bg-bg">
      <button
        type="button"
        onClick={onStepDown}
        disabled={downDisabled}
        aria-label={stepDownLabel}
        className="px-3 py-2 text-lg font-bold text-ink-muted transition hover:text-ink disabled:opacity-30"
      >
        −
      </button>
      <span className="min-w-[7ch] flex-1 px-1 text-center font-mono text-ink">{gel(value)}</span>
      <button
        type="button"
        onClick={onStepUp}
        disabled={upDisabled}
        aria-label={stepUpLabel}
        className="px-3 py-2 text-lg font-bold text-ink-muted transition hover:text-ink disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}

function Spec({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return (
    // A small bordered chip instead of bare stacked text — the spec list
    // was the flattest part of this page, label/value pairs floating with
    // nothing to scan against, no different from a plain paragraph.
    <div className="rounded border border-border/60 bg-surface/50 px-3 py-2">
      <dt className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-faint">
        {icon}
        {label}
      </dt>
      <dd className="mt-0.5 truncate font-medium text-ink">{value}</dd>
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
