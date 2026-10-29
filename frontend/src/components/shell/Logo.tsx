export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Clustrail" className="shrink-0">
      <rect width="64" height="64" rx="15" fill="#13252A" />
      <path d="M17 45c9 0 10-13 15-13s6 5 11 5 5-15 5-15" fill="none" stroke="#3CC4D0" strokeWidth="5" strokeLinecap="round" />
      <circle cx="17" cy="45" r="6" fill="#3CC4D0" />
      <circle cx="48" cy="20" r="6" fill="none" stroke="#3CC4D0" strokeWidth="4" />
    </svg>
  );
}
