"use client";
import { ColumnFilterHeader } from "@/components/ui/column-filter-header";
import { TableHead } from "@/components/ui/table";
import type { PlanFilterKey, PlanFilters } from "./plan-column-filters";

/**
 * A plan-table header cell: the shared clickable filter header when the role may filter by this column, otherwise an
 * ordinary header. (Used by the Sales Planning tables; Recovery Planning builds the same cell inline.)
 */
export function PlanColumnHeader({
  column, label, keys, options, filters, onChange,
}: {
  column: PlanFilterKey;
  label: string;
  keys: readonly PlanFilterKey[];
  options: { value: string; label: string }[];
  filters: PlanFilters;
  onChange: (next: PlanFilters) => void;
}) {
  if (!keys.includes(column)) return <TableHead>{label}</TableHead>;
  return (
    <ColumnFilterHeader
      label={label}
      ariaLabel={`Filter by ${label}`}
      options={options}
      selected={filters[column] ?? []}
      onChange={(next) => onChange({ ...filters, [column]: next })}
    />
  );
}
