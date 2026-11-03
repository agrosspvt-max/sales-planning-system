import { figuresForMode, type FlexFigures, type PlanningMode } from "@/lib/calc";

/**
 * How a stored seasonal plan line becomes the figures the Seasonal workspace shows (Dealer Plan, Product Plan, Dealer Summary) — and the Seasonal
 * Plan Excel export, so the downloaded workbook opens with exactly the screen's figures. Pure; shared by client and server.
 *
 *  - A line's STORED figures follow the mode it was saved in (`inputMode`, null ⇒ PACK_SIZE: the sum of its pack quantities).
 *  - The workspace edits every line in the SEASON's planning mode: PACK_SIZE reads the line's pack quantities; the single-value modes re-express
 *    the stored figures in that mode (Total Qty / Amount / NBV — whichever the season plans in). Nothing is invented: a figure the stored mode
 *    cannot derive is 0.
 */
export interface StoredSeasonalLine {
  inputMode: PlanningMode | null;
  inputValue: number | null;
  packs: Record<string, number>;
  rate: number;
  nbvPercent: number;
}

export function storedLineFigures(l: StoredSeasonalLine): FlexFigures {
  const mode: PlanningMode = l.inputMode ?? "PACK_SIZE";
  const value = mode === "PACK_SIZE" ? Object.values(l.packs).reduce((a, b) => a + b, 0) : l.inputValue ?? 0;
  return figuresForMode(mode, value, l.rate, l.nbvPercent);
}

/** The single editable value of a line in the season's mode (0 for PACK_SIZE, whose inputs are the pack quantities themselves). */
export function seasonalSeedValue(l: StoredSeasonalLine, mode: PlanningMode): number {
  const fig = storedLineFigures(l);
  if (mode === "TOTAL_QUANTITY") return fig.totalQty ?? 0;
  if (mode === "AMOUNT") return fig.amount ?? 0;
  if (mode === "NBV") return fig.nbv ?? 0;
  return 0;
}
