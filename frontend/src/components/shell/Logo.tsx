import { t } from "@/i18n";

/**
 * The Route mark: a transit-map C from an origin ring to a destination stop.
 * At 32px and below the origin ring is dropped and the stroke thickens, so the
 * route stays crisp on a pixel grid (build/appicon-small.svg).
 */
export function Logo({ size = 20 }: { size?: number }) {
  if (size <= 32) {
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={t("Clustrail")} className="shrink-0">
        <rect width="64" height="64" rx="14.5" fill="#13252A" />
        <path d="M45 17H27L17 27V37L27 47H45" fill="none" stroke="#3CC4D0" strokeWidth="9.5" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx="47" cy="47" r="7.4" fill="#F1F5F7" stroke="#13252A" strokeWidth="2.6" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={t("Clustrail")} className="shrink-0">
      <rect width="64" height="64" rx="14.5" fill="#13252A" />
      <path d="M46 17H27L17 27V37L27 47H46" fill="none" stroke="#3CC4D0" strokeWidth="8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx="46.5" cy="17" r="5.4" fill="#13252A" stroke="#F1F5F7" strokeWidth="3.4" />
      <circle cx="46.5" cy="47" r="6.6" fill="#F1F5F7" stroke="#13252A" strokeWidth="2.6" />
    </svg>
  );
}
