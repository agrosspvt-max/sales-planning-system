"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
import { useDealerMarkers } from "@/features/dealers/dealer-name-ui";
import { taggedDealersFirst } from "@/lib/dealer-tags";

export interface SelectOption {
  value: string;
  label: string;
}

export interface NativeSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: SelectOption[];
  placeholder?: string;
  /** Only dealer option values are dealer IDs. Other master/status selectors stay unchanged. */
  dealerOptions?: boolean;
}

const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, options, placeholder, dealerOptions, ...props }, ref) => {
    const tags = useDealerMarkers();
    const ordered = dealerOptions ? taggedDealersFirst(options, (o) => o.value, tags) : options;
    return (
      <select
        ref={ref}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {ordered.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
            {dealerOptions &&
              tags[o.value]
                ?.map((t) => (t.markerType === "TEXT" ? ` [${t.marker}]` : ` ${t.marker}`))
                .join("")}
          </option>
        ))}
      </select>
    );
  },
);
NativeSelect.displayName = "NativeSelect";

export { NativeSelect };
