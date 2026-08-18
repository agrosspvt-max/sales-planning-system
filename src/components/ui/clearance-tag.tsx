/**
 * Small yellow clearance capsule shown wherever a clearance product appears in planning. Clearance is
 * group-specific (looked up by groupId + productId server-side); this is display-only.
 *
 * Always a SINGLE horizontal capsule: `inline-flex` + `whitespace-nowrap` + `shrink-0` so it never
 * wraps to multiple lines even inside a narrow table cell, and `leading-none` keeps row height compact.
 * Format: `⚠ Clr 10` (icon · short label · quantity). Full detail is in the hover tooltip.
 */
export function ClearanceTag({ qty, remaining, state }: { qty?: number | null; remaining?: number | null; state?: string | null }) {
  const shown = remaining ?? qty; // primary number to display (remaining if known, else the target)
  const tip = ["Clearance Product", qty != null ? `Quantity: ${qty}` : null, remaining != null && remaining !== qty ? `Remaining: ${remaining}` : null, state ? `State: ${state}` : null]
    .filter(Boolean)
    .join("\n");
  return (
    <span
      title={tip}
      className="ml-1 inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded bg-warning/15 px-1 py-0.5 align-middle text-[10px] font-medium leading-none text-warning"
    >
      <span aria-hidden>⚠</span> Clr{shown != null ? ` ${shown}` : ""}
    </span>
  );
}
