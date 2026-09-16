import { useEffect, useRef, useState } from "react";

function formatRemaining(ms: number): string {
  if (ms <= 0) return "00:00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// Ticks every second and flashes "EXTENDED" for a few seconds whenever
// `endsAt` moves forward compared to its previous value — that's the bid
// function's soft-close (§5.3) pushing the clock out live, and it's the
// single biggest thing that makes a timed auction feel like Copart's live
// bid wars instead of a static countdown.
export function CountdownTimer({ endsAt, live }: { endsAt: string; live: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const [justExtended, setJustExtended] = useState(false);
  const prevEndsAt = useRef(endsAt);

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
        setJustExtended(true);
        const t = setTimeout(() => setJustExtended(false), 4000);
        prevEndsAt.current = endsAt;
        return () => clearTimeout(t);
      }
      prevEndsAt.current = endsAt;
    }
  }, [endsAt]);

  const remaining = new Date(endsAt).getTime() - now;
  const urgent = live && remaining > 0 && remaining < 5 * 60_000;
  const ended = remaining <= 0;

  return (
    <div className="flex items-center gap-2">
      <span
        className={[
          "font-display text-2xl font-semibold tabular-nums tracking-wide",
          ended ? "text-ink-faint" : urgent ? "text-brand" : "text-ink",
        ].join(" ")}
      >
        {ended ? "ENDED" : formatRemaining(remaining)}
      </span>
      {justExtended && (
        <span className="animate-pulse rounded bg-brand px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-white">
          Extended
        </span>
      )}
    </div>
  );
}
