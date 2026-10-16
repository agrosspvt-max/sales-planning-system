"use client";
import { useLabel } from "@/features/labels/label-ui";
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
  const L = { head: useLabel("dealer_tags.col.sales_officers"), aria: useLabel("dealer_tags.filter.aria"), empty: useLabel("dealer_tags.filter.empty"), all: useLabel("dealer_tags.filter.all") };
  return (
    <ColumnFilterHeader
      label={L.head}
      ariaLabel={L.aria}
      allLabel={L.all}
      options={options.map((o) => ({ value: o.id, label: o.name }))}
      selected={selected}
      onChange={onChange}
      emptyText={L.empty}
    />
  );
}
