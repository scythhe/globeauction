import { useEffect, useRef, useState } from "react";
import { gel } from "../format.ts";

const TWEEN_MS = 600;

// Scoreboard-style: counts up (or down, e.g. after a void-last-bid)
// between values instead of snapping, with a brief flash matching the
// direction — green for a rise, red for a fall. Purely a display effect;
// the actual value driving it is always the server's own current_price,
// never computed here.
export function AnimatedPrice({ value, className = "" }: { value: string; className?: string }) {
  const [displayed, setDisplayed] = useState(() => Number(value));
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const prevValue = useRef(Number(value));
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const from = prevValue.current;
    const to = Number(value);
    if (from === to) return;

    prevValue.current = to;
    setFlash(to > from ? "up" : "down");
    const flashTimeout = setTimeout(() => setFlash(null), 800);

    const start = performance.now();
    function tick(now: number) {
      const progress = Math.min(1, (now - start) / TWEEN_MS);
      // ease-out — fast start, settles into the final number rather than
      // a linear count that feels mechanical.
      const eased = 1 - (1 - progress) * (1 - progress);
      setDisplayed(from + (to - from) * eased);
      if (progress < 1) {
        frame.current = requestAnimationFrame(tick);
      } else {
        setDisplayed(to);
      }
    }
    frame.current = requestAnimationFrame(tick);

    return () => {
      clearTimeout(flashTimeout);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <span
      className={[
        "inline-block rounded transition-colors",
        flash === "up" ? "animate-price-flash" : "",
        flash === "down" ? "animate-price-flash-down" : "",
        className,
      ].join(" ")}
    >
      {gel(displayed)}
    </span>
  );
}
