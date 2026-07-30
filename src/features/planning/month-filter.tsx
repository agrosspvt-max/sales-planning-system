"use client";

import { NativeSelect } from "@/components/ui/select";
import type { MonthStatus } from "./planning-state";

export interface MonthMeta {
  id: string;
  name: string;
  order: number;
  status: MonthStatus;
}

export type MonthFilterMode = "season" | "till" | "selected" | "range";

export interface MonthFilterState {
  mode: MonthFilterMode;
  selectedIds: string[];
  rangeStartOrder: number;
  rangeEndOrder: number;
}

export function defaultMonthFilter(months: MonthMeta[]): MonthFilterState {
  return {
    mode: "season",
    selectedIds: months.map((m) => m.id),
    rangeStartOrder: months[0]?.order ?? 1,
    rangeEndOrder: months[months.length - 1]?.order ?? 1,
  };
}

/**
 * Resolve which month ids to aggregate for the current filter — a DISPLAY-only concern
 * (stored data is never changed). "Till Current Month" = every month management has opened
 * so far (status is not LOCKED).
 */
export function resolveFilteredMonths(months: MonthMeta[], state: MonthFilterState): string[] {
  switch (state.mode) {
    case "season":
      return months.map((m) => m.id);
    case "till":
      return months.filter((m) => m.status !== "LOCKED").map((m) => m.id);
    case "selected":
      return months.filter((m) => state.selectedIds.includes(m.id)).map((m) => m.id);
    case "range":
      return months.filter((m) => m.order >= state.rangeStartOrder && m.order <= state.rangeEndOrder).map((m) => m.id);
  }
}

/** Compact filter control shared by the monthly Product Plan and Dealer Summary. */
export function MonthFilter({
  months,
  state,
  onChange,
}: {
  months: MonthMeta[];
  state: MonthFilterState;
  onChange: (next: MonthFilterState) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">Aggregate:</span>
      <NativeSelect
        className="w-44"
        options={[
          { value: "season", label: "Season Total" },
          { value: "till", label: "Till Current Month" },
          { value: "selected", label: "Selected Months" },
          { value: "range", label: "Custom Range" },
        ]}
        value={state.mode}
        onChange={(e) => onChange({ ...state, mode: e.target.value as MonthFilterMode })}
      />

      {state.mode === "range" && (
        <>
          <NativeSelect
            className="w-32"
            options={months.map((m) => ({ value: String(m.order), label: m.name }))}
            value={String(state.rangeStartOrder)}
            onChange={(e) => onChange({ ...state, rangeStartOrder: Number(e.target.value) })}
          />
          <span className="text-muted-foreground">to</span>
          <NativeSelect
            className="w-32"
            options={months.map((m) => ({ value: String(m.order), label: m.name }))}
            value={String(state.rangeEndOrder)}
            onChange={(e) => onChange({ ...state, rangeEndOrder: Number(e.target.value) })}
          />
        </>
      )}

      {state.mode === "selected" && (
        <div className="flex flex-wrap gap-2">
          {months.map((m) => {
            const on = state.selectedIds.includes(m.id);
            return (
              <label key={m.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5"
                  checked={on}
                  onChange={(e) =>
                    onChange({
                      ...state,
                      selectedIds: e.target.checked ? [...state.selectedIds, m.id] : state.selectedIds.filter((id) => id !== m.id),
                    })
                  }
                />
                {m.name}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
