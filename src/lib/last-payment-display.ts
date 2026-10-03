/**
 * How the Recovery "Last Payment" cell should render — a pure, display-only decision shared by Month View
 * and Week View. It does NOT touch receipt selection, Current Outstanding, or any stored data.
 *
 *   - real:     a receipt date exists → show that receipt's real date + amount (UNCHANGED behaviour). A
 *               receipt always wins, so when a later Daybook / Historical Daybook upload supplies a valid
 *               receipt the existing Last Payment logic produces a date here and the fallback disappears
 *               automatically — nothing is stored or synthesised.
 *   - fallback: no receipt AND the dealer still owes money (Current Outstanding > 0) → a display-only
 *               placeholder. Not a real receipt or stored payment. The placeholder TEXT comes from the
 *               label dictionary (`recovery.lastPaymentFallback`); this function only decides the kind.
 *   - empty:    no receipt and Current Outstanding is 0 or negative → the existing blank/dash display.
 */
export type LastPaymentDisplay =
  | { kind: "real"; date: string; amount: number }
  | { kind: "fallback" }
  | { kind: "empty" };

export function lastPaymentDisplay(input: {
  date: string | null;
  amount: number | null;
  outstanding: number;
}): LastPaymentDisplay {
  // A real eligible receipt always wins (replaces any fallback once a valid receipt becomes available).
  if (input.date) return { kind: "real", date: input.date, amount: input.amount ?? 0 };
  // No receipt: show the placeholder only while the dealer still owes money.
  if (input.outstanding > 0) return { kind: "fallback" };
  return { kind: "empty" };
}
