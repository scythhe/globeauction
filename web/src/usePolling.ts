import { useEffect, useRef } from "react";

// Deliberately simple polling, not WebSockets — for one auction with a
// handful of concurrent bidders, a few seconds of lag is unlikely to
// matter, and this needs no new dependency, no connection-lifecycle code,
// and no reconnect logic. Revisit if sub-second updates ever matter.
export function usePolling(callback: () => void, intervalMs: number, enabled: boolean) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => callbackRef.current(), intervalMs);
    return () => clearInterval(interval);
  }, [intervalMs, enabled]);
}
