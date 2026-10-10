/** Week View shows each week's date range under its label — from the app's ONE business-week definition, correct for every month length. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { weekRangeLabel } from "./recovery-calc";

const { businessWeekDayRange, BUSINESS_WEEK_COUNT } = testLoader({ "@/lib/prisma": { prisma: {} }, "@/lib/http": { ApiError: Error }, "@/lib/audit": { writeAudit: async () => undefined } })("src/features/recovery/service.server.ts") as {
  businessWeekDayRange: (w: number, y: number, m0: number) => { startDay: number; endDay: number }; BUSINESS_WEEK_COUNT: number;
};
const labels = (year: number, month0: number) => Array.from({ length: BUSINESS_WEEK_COUNT }, (_, i) => weekRangeLabel({ weekNo: i + 1, ...businessWeekDayRange(i + 1, year, month0) })).join(" | ");

// Boundaries: 1–7, 8–14, 15–22 and 23–month end. Week 4 is labelled "23–End" for every month length (never 28/29/30/31).
assert.equal(labels(2026, 9), "1–7 | 8–14 | 15–22 | 23–End", "October (31 days)");
assert.equal(labels(2026, 8), "1–7 | 8–14 | 15–22 | 23–End", "September (30 days)");
assert.equal(labels(2026, 1), "1–7 | 8–14 | 15–22 | 23–End", "February, common year (28 days)");
assert.equal(labels(2028, 1), "1–7 | 8–14 | 15–22 | 23–End", "February, leap year (29 days)");
assert.equal(labels(2100, 1), "1–7 | 8–14 | 15–22 | 23–End", "2100 is not a leap year");
assert.equal(labels(2026, 11), "1–7 | 8–14 | 15–22 | 23–End", "December → year-end handled");
assert.equal(weekRangeLabel(undefined), "", "no lock info → nothing shown (never a wrong range)");
assert.equal(weekRangeLabel({ weekNo: 4, startDay: 23, endDay: 29 }), "23–End", "Week 4 always reads End");

// Every week of every month: the ranges are contiguous, start at 1 and end on the month's last day (no gap / overlap).
for (const year of [2025, 2026, 2028, 2100]) for (let m0 = 0; m0 < 12; m0++) {
  const last = new Date(year, m0 + 1, 0).getDate();
  let next = 1;
  for (let w = 1; w <= BUSINESS_WEEK_COUNT; w++) { const r = businessWeekDayRange(w, year, m0); assert.equal(r.startDay, next, `${year}-${m0 + 1} W${w} starts where the previous ended`); next = r.endDay + 1; }
  assert.equal(next - 1, last, `${year}-${m0 + 1}: last week ends on day ${last}`);
}

// The UI: range on a second line under the label, small + muted; lock icons, selection styling and the week buttons are kept.
const ui = readFileSync("src/features/recovery/recovery-workspace.tsx", "utf8");
const week = ui.slice(ui.indexOf("function WeekView"), ui.indexOf("function WeekGrid"));
assert.ok(/flex flex-col items-start leading-tight/.test(week) && /<span className="font-medium">Week \{wk\}<\/span>/.test(week), "label on the first line");
assert.ok(/text-\[11px\][^"]*text-muted-foreground[^>]*>\{weekRangeLabel\(lock\)\}/.test(week), "range below it, smaller and muted, from the server-provided week definition");
assert.ok(week.includes("onClick={() => setWeekNo(wk)}") && week.includes("<Lock className") && week.includes("<Unlock className") && week.includes('selected ? "border-primary bg-accent"') && week.includes("toggleMut.mutate(wk)"), "selection, lock icons and admin toggle unchanged");
assert.ok(!/new Date\(|Date\.now|getDate\(/.test(week), "the component computes no dates itself");
console.log("recovery-week-range.test.ts — all assertions passed");
