import type { ReactNode } from "react";

/** Shared Daily Work fieldset chrome used by the owner editor and Admin read-only viewer. */
export function DailyWorkFieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 rounded-lg border bg-background px-3 pb-4 pt-1 sm:px-4">
      <legend className="max-w-[calc(100%-1rem)] bg-background px-2 text-sm font-semibold leading-6 text-foreground">
        {legend}
      </legend>
      <div className="min-w-0 space-y-4 pt-1">{children}</div>
    </fieldset>
  );
}
