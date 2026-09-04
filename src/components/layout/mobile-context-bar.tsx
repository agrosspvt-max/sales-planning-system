"use client";

import { BackButton } from "./back-button";

/**
 * Mobile-only compact context bar for the planning/recovery workspaces. On phones the large glass
 * PageHeader is hidden and replaced by this single slim row — Back + the essential context
 * (Season · Month · Officer) — so almost all of the viewport goes to the data grid. Desktop/tablet
 * keep the full PageHeader. It carries no title treatment, breadcrumbs, subtitle, status badge or
 * action buttons by design (those live in the desktop header or the dedicated mobile action bars).
 */
export function MobileContextBar({
  backTo,
  items,
}: {
  backTo?: string;
  items: (string | null | undefined)[];
}) {
  const parts = items.filter((s): s is string => !!s && s.trim().length > 0);
  return (
    <div className="-mx-4 -mt-4 mb-2 flex items-center gap-1 border-b bg-background/95 px-2 py-1.5 backdrop-blur sm:hidden">
      <BackButton to={backTo} className="shrink-0" />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap text-sm font-medium [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {parts.map((p, i) => (
          <span key={i} className="flex shrink-0 items-center gap-1.5">
            {i > 0 && <span className="text-muted-foreground/40">·</span>}
            <span className={i === parts.length - 1 ? "text-muted-foreground" : "text-foreground"}>{p}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
