"use client";
import { ColumnFilterHeader, filterHeaderLabel, toggleFilterValue } from "@/components/ui/column-filter-header";

export interface SalesOfficerOption {
  id: string;
  name: string;
}

/** Add the officer if absent, remove it if present. Multiple selections are OR-ed by the server. */
export const toggleOfficerId = toggleFilterValue;

/** The header label, with the active-filter count: "Sales Officers" / "Sales Officers (2)". */
export const salesOfficersHeaderLabel = (count: number): string => filterHeaderLabel("Sales Officers", count);

/** Dealer Tags' Sales Officers column filter — the shared ColumnFilterHeader configured for officers. */
export function SalesOfficerFilterHeader({
  options,
  selected,
  onChange,
}: {
  options: SalesOfficerOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <ColumnFilterHeader
      label="Sales Officers"
      ariaLabel="Filter by Sales Officers"
      options={options.map((o) => ({ value: o.id, label: o.name }))}
      selected={selected}
      onChange={onChange}
      emptyText="No Sales Officers"
    />
  );
}
