import type { ReactNode } from "react";

// Building blocks of the Settings page.

export function Section({ id, icon, title, trailing, children }: { id: string; icon: ReactNode; title: string; trailing?: ReactNode; children: ReactNode }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  if (items.length === 0) return null;
  return (
    <section id={`settings-${id}`} aria-label={title} className="flex scroll-mt-4 flex-col rounded-[10px] border border-line bg-surface-panel">
      <h2 className="m-0 flex items-center gap-2 border-b border-line px-3.5 py-2.5 text-body font-semibold [&>svg]:size-4 [&>svg]:shrink-0">
        {icon}
        {title}
        <span className="flex-1" />
        {trailing}
      </h2>
      {items}
    </section>
  );
}

export function Setting({ label, detail, children }: { label: ReactNode; detail?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-t border-line-row px-3.5 py-[9px] text-cell first-of-type:border-t-0">
      <div className="min-w-0">
        <div>{label}</div>
        {detail && <div className="mt-0.5 text-meta leading-[1.35] text-fg-muted">{detail}</div>}
      </div>
      {children}
    </div>
  );
}
