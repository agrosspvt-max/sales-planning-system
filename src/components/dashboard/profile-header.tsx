"use client";

import { Badge } from "@/components/ui/badge";

export interface ProfileField {
  label: string;
  value: string;
}

/** Reusable profile header — a labelled field grid used by the entity dashboards. */
export function ProfileHeaderFields({ fields }: { fields: ProfileField[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border bg-background p-4 sm:grid-cols-3 lg:grid-cols-4">
      {fields.map((f) => (
        <div key={f.label} className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{f.label}</p>
          {f.label === "Status" ? (
            <Badge variant={f.value === "Active" ? "success" : "muted"} className="mt-1">
              {f.value}
            </Badge>
          ) : (
            <p className="mt-0.5 truncate text-sm font-medium">{f.value}</p>
          )}
        </div>
      ))}
    </div>
  );
}
