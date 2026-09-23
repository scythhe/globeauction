import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n/index.tsx";

function formatRemaining(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// auctions.soft_close_extension comes back as a Postgres interval in
// "HH:MM:SS" form. The ring's capacity is that same duration — it's meant
// to read as "how much buffer is left before this needs another bid," so
// it has to be the actual soft-close number, not an arbitrary window.
function parseIntervalMs(interval: string, fallbackMs: number): number {
  const match = /^(\d+):(\d+):(\d+)/.exec(interval);
  if (!match) return fallbackMs;
  const [, h, m, s] = match;
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000;
}

const DEFAULT_RING_WINDOW_MS = 15_000;
const RING_RADIUS = 30;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// Ticks every second and flashes "EXTENDED" for a few seconds whenever
// `endsAt` moves forward compared to its previous value — that's the bid
// function's soft-close (§5.3) pushing the clock out live, and it's the
// single biggest thing that makes a timed auction feel like Copart's live
// bid wars instead of a static countdown.
export function CountdownTimer({
  endsAt,
  live,
  size = "lg",
  bonusExtensionUsed = false,
  softCloseExtension,
}: {
  endsAt: string;
  live: boolean;
  size?: "sm" | "lg";
  // db/012's one-time bonus round flipping this false -> true is what
  // tells us THIS particular extension was the bonus, not just another
  // ordinary per-bid soft close — same endsAt-moved-forward signal, but
  // the badge needs to say something different so bidders don't mistake
  // a once-only grace period for the normal repeatable one.
  bonusExtensionUsed?: boolean;
  // auctions.soft_close_extension ("HH:MM:SS") — sets the ring's capacity.
  softCloseExtension?: string;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  const [justExtended, setJustExtended] = useState<"normal" | "bonus" | null>(null);
  // A jump in endsAt (soft close or bonus round) should make the ring
  // reappear already at its new level, not visibly sweep backward from
  // wherever it had drained to — that reads as time running in reverse.
  // Only the ordinary second-by-second drain animates.
  const [skipRingTransition, setSkipRingTransition] = useState(false);
  const prevEndsAt = useRef(endsAt);
  const prevBonusUsed = useRef(bonusExtensionUsed);

  const ringWindowMs = softCloseExtension
    ? parseIntervalMs(softCloseExtension, DEFAULT_RING_WINDOW_MS)
    : DEFAULT_RING_WINDOW_MS;

  useEffect(() => {
    if (!live) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [live]);

  useEffect(() => {
    if (prevEndsAt.current !== endsAt) {
      const prevTime = new Date(prevEndsAt.current).getTime();
      const newTime = new Date(endsAt).getTime();
      if (newTime > prevTime) {
        const isBonus = bonusExtensionUsed && !prevBonusUsed.current;
        setJustExtended(isBonus ? "bonus" : "normal");
        setSkipRingTransition(true);
        setNow(Date.now());
        const badgeTimeout = setTimeout(() => setJustExtended(null), 4000);
        // Let the snapped (no-transition) frame paint, then re-enable the
        // transition so the *next* tick still drains smoothly.
        const raf = requestAnimationFrame(() => setSkipRingTransition(false));
        prevEndsAt.current = endsAt;
        prevBonusUsed.current = bonusExtensionUsed;
        return () => {
          clearTimeout(badgeTimeout);
          cancelAnimationFrame(raf);
        };
      }
      prevEndsAt.current = endsAt;
    }
    prevBonusUsed.current = bonusExtensionUsed;
  }, [endsAt, bonusExtensionUsed]);

  const remaining = new Date(endsAt).getTime() - now;
  // Deliberately NOT `!live && remaining <= 0` — the server, not the local
  // clock, decides when an auction is over. Reaching 00:00 while `live` is
  // still true just means the closing job (now 1s-granularity, db/012)
  // hasn't landed its decision yet: it might grant a bonus round instead of
  // closing. Declaring "ended" from the client clock alone is exactly the
  // "ended, then revived" flicker this was built to avoid — so at 00:00
  // with live still true, keep showing 00:00, not the ended label.
  const ended = !live;
  const urgent = live && remaining < 5 * 60_000;
  // The ring (and the pulsing drama) only cover the soft-close window
  // itself — a ring drawn against the full auction duration would be
  // meaningless (a few seconds out of hours), and this is also exactly the
  // stretch where a bid actually still changes the outcome.
  const critical = live && remaining < ringWindowMs;

  return (
    <div className="relative inline-flex items-center">
      {critical && size === "lg" ? (
        <div className="relative inline-flex h-20 w-20 items-center justify-center animate-heartbeat animate-glow-pulse">
          <svg viewBox="0 0 68 68" className="absolute inset-0 h-full w-full -rotate-90">
            <circle cx="34" cy="34" r={RING_RADIUS} fill="none" stroke="var(--color-border)" strokeWidth="4" />
            <circle
              cx="34"
              cy="34"
              r={RING_RADIUS}
              fill="none"
              stroke="var(--color-brand)"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={RING_CIRCUMFERENCE * (1 - Math.max(0, remaining) / ringWindowMs)}
              className={skipRingTransition ? "" : "transition-[stroke-dashoffset] duration-1000 ease-linear"}
            />
          </svg>
          <span className="font-display relative text-lg font-bold tabular-nums text-brand">
            {formatRemaining(remaining)}
          </span>
        </div>
      ) : (
        <span
          className={[
            "font-display inline-block font-semibold tabular-nums tracking-wide",
            size === "sm" ? "text-sm" : "text-2xl",
            ended ? "text-ink-faint" : urgent ? "text-brand" : "text-ink",
            critical ? "animate-heartbeat animate-glow-pulse" : "",
          ].join(" ")}
        >
          {ended ? t("countdown.ended") : formatRemaining(remaining)}
        </span>
      )}
      {justExtended && (
        <span
          className={[
            "animate-badge-pop whitespace-nowrap rounded-full bg-gradient-to-r from-brand to-brand-hover font-bold uppercase tracking-wider text-white shadow-[0_0_10px_-1px_var(--color-brand)]",
            size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs",
            // On the big detail-page timer this sits inside a
            // justify-between row, so appearing in normal flow shoves the
            // number/ring sideways every time. Take it out of flow there;
            // the small list-card badge is already an isolated floating
            // chip where that never happened, so it stays inline.
            size === "lg" ? "absolute top-full right-0 mt-1" : "ml-2",
          ].join(" ")}
        >
          {justExtended === "bonus" ? t("countdown.bonusTime") : t("countdown.extended")}
        </span>
      )}
    </div>
  );
}
