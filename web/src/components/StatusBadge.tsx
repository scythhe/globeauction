import { useTranslation } from "../i18n/index.tsx";

const STYLES: Record<string, string> = {
  live: "bg-live/15 text-live border-live/40",
  scheduled: "bg-warn/15 text-warn border-warn/40",
  sold: "bg-brand/15 text-brand border-brand/40",
  unsold: "bg-ink-faint/15 text-ink-muted border-ink-faint/40",
  cancelled: "bg-ink-faint/15 text-ink-muted border-ink-faint/40",
  pending_seller: "bg-warn/15 text-warn border-warn/40",
  counter_offered: "bg-warn/15 text-warn border-warn/40",
};

export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const style = STYLES[status] ?? STYLES.unsold;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider ${style}`}
    >
      {status === "live" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-live" />}
      {t(`status.${status}`)}
    </span>
  );
}
