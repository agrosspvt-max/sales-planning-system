/**
 * Daily Work PURE helper tests (`daily-work.ts`). DB-free.
 *   npx tsx src/lib/daily-work.test.ts
 *
 * Covers the business rules the spec fixes:
 *   - current running month resolution (Sept vs Oct, off-season)
 *   - SALES Pending = current-month plan − current-month actual (NOT season total)
 *   - RECOVERY Pending = Total Recovery Plan − Actual Total Recovery
 *   - combined summary derived from dealer rows (matches the screenshot totals)
 *   - Type collapses to shared value or MIXED
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  currentBusinessDate, currentMonthName, resolveCurrentSeasonMonth, monthNameForDate, resolveSeasonMonthByName,
  salesPending, recoveryPending, conversionPending, combineDailyWorkRows, dealerCountLabel, marketCountLabel,
  combineAppointmentRows, combineConversionRows, type DailyWorkDealerRow, type AppointmentRow, type ConversionRow,
  computeSectionStatuses, sectionStatusCounts, canSubmitDailyWork, sectionStatus, parseNoPlanSet, serializeNoPlanSet,
  MANDATORY_SECTIONS, SectionStatus, type SectionDataPresence,
  rowTaskType, combineTaskType, type TaskType,
  DailyWorkView, DEFAULT_DAILY_WORK_VIEW, dailyWorkShowsResults, visibleDailyWorkRows,
  paymentModeApplies, paymentModeForActual,
  addBusinessDays, previousBusinessDate, dailyReportDeadline, isReportDeadlinePassed, previousReportState, previousReportBlocksPlan, isReportMissed, resolveReportDate,
  isValidTodaysPlan, invalidPlanRows, planRequiredMessage,
} from "./daily-work";
import { DEFAULT_LABELS, labelCatalog, resolveLabels } from "@/features/labels/labels";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }

/* ---------- Authoritative India business date ---------- */
test("currentBusinessDate uses Asia/Kolkata without a UTC day shift", () => {
  assert.equal(currentBusinessDate(new Date("2026-09-21T18:29:59.000Z")), "2026-09-21");
  assert.equal(currentBusinessDate(new Date("2026-09-21T18:30:00.000Z")), "2026-09-22");
  assert.equal(currentBusinessDate(new Date("2026-09-22T00:15:00.000Z")), "2026-09-22");
});
test("Daily Work page has no day picker and derives its date automatically", () => {
  const page = readFileSync(resolve("src/features/daily-work/daily-work-page.tsx"), "utf8");
  // The Daily Work DAY is auto-derived from the server business date — never a manual day picker.
  assert.match(page, /useState\(currentBusinessDate\)/);
  // The only date inputs allowed are CN follow-up "Task Date" pickers (the SO schedules a CN task). Every
  // date input must be a labelled CN task-date input, never a Daily Work day picker.
  const dateInputs = (page.match(/type=["']date["']/g) ?? []).length;
  const cnTaskDateInputs = (page.match(/aria-label=\{`\$\{L\.taskDate\}/g) ?? []).length;
  assert.equal(dateInputs, cnTaskDateInputs, "the only date inputs are CN Task Date pickers");
});
test("public Daily Work routes make the current business date authoritative", () => {
  const routeRoot = resolve("src/app/api/daily-work");
  for (const path of ["route.ts", "status/route.ts", "save/route.ts", "submit/route.ts", "actual/route.ts", "no-plan/route.ts", "submit-day/route.ts"]) {
    const source = readFileSync(resolve(routeRoot, path), "utf8");
    // Plan routes are always today. Report routes (status / section reads / actual) may also target YESTERDAY's still-open report,
    // but only through resolveReportDate (today or yesterday, nothing else); the service enforces the noon deadline.
    const reportRoute = ["route.ts", "status/route.ts", "actual/route.ts"].includes(path);
    assert.match(source, reportRoute ? /currentBusinessDate\(\)|resolveReportDate\(/ : /currentBusinessDate\(\)/, `${path} must use the server business date`);
  }
  assert.match(readFileSync(resolve(routeRoot, "submit-report/route.ts"), "utf8"), /resolveReportDate\(/, "report submission may target yesterday's open report");
  for (const path of ["save/route.ts", "submit/route.ts", "no-plan/route.ts", "submit-day/route.ts"]) {
    assert.doesNotMatch(readFileSync(resolve(routeRoot, path), "utf8"), /resolveReportDate/, `${path} always works on today`);
  }
});

/* ---------- Current running month ---------- */
test("currentMonthName reflects the real calendar month", () => {
  assert.equal(currentMonthName(new Date("2026-09-21T10:00:00Z")), "September");
  assert.equal(currentMonthName(new Date("2026-10-01T10:00:00Z")), "October");
});
test("resolveCurrentSeasonMonth picks September in September, October in October", () => {
  const months = [{ id: "m8", name: "August" }, { id: "m9", name: "September" }, { id: "m10", name: "October" }];
  assert.equal(resolveCurrentSeasonMonth(months, new Date("2026-09-21T00:00:00Z"))?.id, "m9");
  assert.equal(resolveCurrentSeasonMonth(months, new Date("2026-10-05T00:00:00Z"))?.id, "m10");
});
test("resolveCurrentSeasonMonth returns null off-season (no fallback to a season total)", () => {
  const months = [{ id: "m9", name: "September" }, { id: "m10", name: "October" }];
  assert.equal(resolveCurrentSeasonMonth(months, new Date("2026-12-01T00:00:00Z")), null);
});
test("monthNameForDate derives the month from the Daily Work DATE (not the server clock)", () => {
  assert.equal(monthNameForDate("2026-09-21"), "September");
  assert.equal(monthNameForDate("2026-09-30"), "September");
  assert.equal(monthNameForDate("2026-10-01"), "October");
  assert.equal(monthNameForDate("2026-10-15"), "October");
  assert.equal(monthNameForDate("garbage"), null);
});
test("resolveSeasonMonthByName matches the SeasonMonth for that month name (Selected Months = one month)", () => {
  const months = [{ id: "m9", name: "September" }, { id: "m10", name: "October" }];
  assert.equal(resolveSeasonMonthByName(months, monthNameForDate("2026-09-21"))?.id, "m9");
  assert.equal(resolveSeasonMonthByName(months, monthNameForDate("2026-10-15"))?.id, "m10");
  assert.equal(resolveSeasonMonthByName(months, monthNameForDate("2026-12-01")), null); // December not in season
});

/* ---------- Pending formulas (distinct for Sales vs Recovery) ---------- */
test("SALES Pending = current-month plan − current-month actual", () => {
  assert.equal(salesPending(300000, 220000), 80000); // spec example
  assert.equal(salesPending(250000, 190000), 60000);
});
test("RECOVERY Pending = Total Recovery Plan − Actual Total Recovery", () => {
  assert.equal(recoveryPending(200000, 120000), 80000); // spec example
  assert.equal(recoveryPending(150000, 90000), 60000);
});
test("Pending rounds to paise (no float drift)", () => {
  assert.equal(salesPending(0.3, 0.1), 0.2);
});

/* ---------- Combined summary (matches the screenshot) ---------- */
const salesRows: DailyWorkDealerRow[] = [
  { monthlyPlan: 300000, actual: 220000, pending: 80000, todaysPlan: 30000, todaysActual: 25000, type: "REGULAR" },
  { monthlyPlan: 250000, actual: 190000, pending: 60000, todaysPlan: 20000, todaysActual: 15000, type: "SCHEME" },
];

test("Combined row sums plan/pending/today's plan/today's sales (screenshot: 5.5L / 1.4L / 50K / 40K)", () => {
  const c = combineDailyWorkRows(salesRows);
  assert.equal(c.monthlyPlan, 550000);
  assert.equal(c.actual, 410000); // Σ current-month actual sales (220000 + 190000)
  assert.equal(c.pending, 140000);
  assert.equal(c.todaysPlan, 50000);
  assert.equal(c.todaysActual, 40000);
});
test("Combined dealer label counts selected dealers", () => {
  assert.equal(dealerCountLabel(1), "1 Dealer");
  assert.equal(dealerCountLabel(2), "2 Dealers");
  assert.equal(combineDailyWorkRows(salesRows).dealerLabel, "2 Dealers");
  assert.equal(combineDailyWorkRows([salesRows[0]]).dealerLabel, "1 Dealer");
});
test("Combined count nouns use configured Daily Work labels without changing counts", () => {
  assert.equal(dealerCountLabel(1, { dealer: "Partner", dealers: "Partners" }), "1 Partner");
  assert.equal(dealerCountLabel(2, { dealer: "Partner", dealers: "Partners" }), "2 Partners");
  const c = combineDailyWorkRows(salesRows, { dealer: "Partner", dealers: "Partners" });
  assert.equal(c.dealerLabel, "2 Partners");
});
test("Daily Work labels resolve persisted overrides and are catalogued under Daily Work", () => {
  const resolved = resolveLabels({ "daily_work.section.sales": "Orders", "daily_work.progress.sections": "Activities" });
  assert.equal(resolved["daily_work.section.sales"], "Orders");
  assert.equal(resolved["daily_work.progress.sections"], "Activities");
  assert.equal(resolved["daily_work.section.recovery"], DEFAULT_LABELS["daily_work.section.recovery"]);
  const dailyEntries = labelCatalog({}).filter((entry) => entry.key.startsWith("daily_work."));
  assert.ok(dailyEntries.length > 0);
  assert.ok(dailyEntries.every((entry) => entry.module === "Daily Work"));
});
test("Combined Type: shared value collapses; differing values → MIXED", () => {
  assert.equal(combineDailyWorkRows([salesRows[0]]).type, "REGULAR"); // all Regular
  assert.equal(combineDailyWorkRows([{ ...salesRows[0], type: "SCHEME" }, { ...salesRows[1], type: "SCHEME" }]).type, "SCHEME");
  assert.equal(combineDailyWorkRows(salesRows).type, "MIXED"); // Regular + Scheme
});
test("Combined for an empty selection is all zero with null type", () => {
  const c = combineDailyWorkRows([]);
  assert.equal(c.dealerCount, 0);
  assert.equal(c.monthlyPlan, 0);
  assert.equal(c.pending, 0);
  assert.equal(c.type, null);
});
test("Changing dealter selection changes the combined row (add a dealer → totals grow)", () => {
  const one = combineDailyWorkRows([salesRows[0]]);
  const two = combineDailyWorkRows(salesRows);
  assert.equal(one.monthlyPlan, 300000);
  assert.equal(two.monthlyPlan, 550000);
  assert.notEqual(one.todaysActual, two.todaysActual);
});

/* ---------- Section 3 — Dealer Appointment combined ---------- */
test("Appointment combined: dealer count + UNIQUE market count", () => {
  const rows: AppointmentRow[] = [
    { marketName: "Bhopal", status: null }, { marketName: "Bhopal", status: null }, { marketName: "Sehore", status: null },
  ];
  const c = combineAppointmentRows(rows);
  assert.equal(c.dealerCount, 3);
  assert.equal(c.dealerLabel, "3 Dealers");
  assert.equal(c.marketCount, 2, "Bhopal + Sehore = 2 unique markets");
  assert.equal(c.marketLabel, "2 Markets");
  assert.equal(marketCountLabel(1), "1 Market");
});
test("Appointment combined uses configured dealer and market count nouns", () => {
  const c = combineAppointmentRows([{ marketName: "North", status: null }, { marketName: "South", status: null }], {
    dealer: "Partner", dealers: "Partners", market: "Territory", markets: "Territories",
  });
  assert.equal(c.dealerLabel, "2 Partners");
  assert.equal(c.marketLabel, "2 Territories");
});
test("Appointment combined status: shared collapses, mixed → MULTIPLE, none → null", () => {
  assert.equal(combineAppointmentRows([{ marketName: "X", status: "APPOINTED" }, { marketName: "Y", status: "APPOINTED" }]).status, "APPOINTED");
  assert.equal(combineAppointmentRows([{ marketName: "X", status: "APPOINTED" }, { marketName: "Y", status: "NOT_APPOINTED" }]).status, "MULTIPLE");
  assert.equal(combineAppointmentRows([{ marketName: "X", status: null }]).status, null);
});
test("Appointment combined ignores blank markets in the unique count", () => {
  assert.equal(combineAppointmentRows([{ marketName: "Bhopal", status: null }, { marketName: "", status: null }]).marketCount, 1);
});

/* ---------- Section 4 — Scheme Conversion combined ---------- */
test("conversionPending = planned − converted (units, floored at 0)", () => {
  assert.equal(conversionPending(6, 2), 4);
  assert.equal(conversionPending(6, 6), 0);
  assert.equal(conversionPending(6, 9), 0); // never negative
});
test("Conversion combined (spec example): 2 dealers, Multiple scheme, Σ units, Multiple achievability", () => {
  const rows: ConversionRow[] = [
    { schemeId: "A", plannedUnits: 6, pending: 4, todaysPlan: 2, achievability: "YES" },
    { schemeId: "B", plannedUnits: 8, pending: 5, todaysPlan: 3, achievability: "NO" },
  ];
  const c = combineConversionRows(rows);
  assert.equal(c.dealerLabel, "2 Dealers");
  assert.equal(c.scheme, "MULTIPLE", "different schemes → Multiple");
  assert.equal(c.plannedUnits, 14);
  assert.equal(c.pending, 9);
  assert.equal(c.todaysPlan, 5);
  assert.equal(c.achievability, "MULTIPLE", "Yes + No → Multiple (never numeric)");
});
test("Conversion combined: same scheme shows that scheme; all-Yes → YES; none → null", () => {
  assert.equal(combineConversionRows([{ schemeId: "A", plannedUnits: 6, pending: 4, todaysPlan: 2, achievability: "YES" }, { schemeId: "A", plannedUnits: 3, pending: 3, todaysPlan: 1, achievability: "YES" }]).scheme, "A");
  assert.equal(combineConversionRows([{ schemeId: "A", plannedUnits: 6, pending: 4, todaysPlan: 2, achievability: "YES" }, { schemeId: "A", plannedUnits: 3, pending: 3, todaysPlan: 1, achievability: "YES" }]).achievability, "YES");
  assert.equal(combineConversionRows([{ schemeId: "A", plannedUnits: 6, pending: 4, todaysPlan: 0, achievability: null }]).achievability, null);
});

/* ---------- Section completion (progress bar + No Plan + submit gate) ---------- */
const noData: SectionDataPresence = { SALES: false, RECOVERY: false, APPOINTMENT: false, SCHEME_CONVERSION: false, VISITS: false, OTHERS: false };
const statusesFor = (data: SectionDataPresence, noPlan: string[]) => computeSectionStatuses(data, new Set(noPlan));

test("sectionStatus: data ⇒ FILLED (No Plan ignored); No Plan ⇒ NO_PLAN; else REMAINING", () => {
  assert.equal(sectionStatus(true, false), SectionStatus.FILLED);
  assert.equal(sectionStatus(true, true), SectionStatus.FILLED, "data wins — No Plan + data never coexist");
  assert.equal(sectionStatus(false, true), SectionStatus.NO_PLAN);
  assert.equal(sectionStatus(false, false), SectionStatus.REMAINING);
});
test("MANDATORY_SECTIONS has exactly the 5 ACTIVE mandatory sections (Scheme Conversion temporarily disabled; Others compulsory)", () => {
  assert.equal(MANDATORY_SECTIONS.join(","), "SALES,RECOVERY,APPOINTMENT,VISITS,OTHERS");
  assert.ok((MANDATORY_SECTIONS as readonly string[]).includes("OTHERS"));
});
test("1) all empty → 0/0/5 · submit disabled", () => {
  const s = statusesFor(noData, []);
  assert.deepEqual(sectionStatusCounts(s), { filled: 0, noPlan: 0, remaining: 5, total: 5 });
  assert.equal(canSubmitDailyWork(s), false);
});
test("2) one section filled → 1/0/4 · submit disabled", () => {
  const s = statusesFor({ ...noData, SALES: true }, []);
  assert.deepEqual(sectionStatusCounts(s), { filled: 1, noPlan: 0, remaining: 4, total: 5 });
  assert.equal(canSubmitDailyWork(s), false);
});
test("3) one section No Plan → 0/1/4 · submit disabled", () => {
  const s = statusesFor(noData, ["RECOVERY"]);
  assert.deepEqual(sectionStatusCounts(s), { filled: 0, noPlan: 1, remaining: 4, total: 5 });
  assert.equal(canSubmitDailyWork(s), false);
});
test("4) all 5 active sections filled → submit ENABLED", () => {
  const s = statusesFor({ SALES: true, RECOVERY: true, APPOINTMENT: true, SCHEME_CONVERSION: true, VISITS: true, OTHERS: true }, []);
  assert.deepEqual(sectionStatusCounts(s), { filled: 5, noPlan: 0, remaining: 0, total: 5 });
  assert.equal(canSubmitDailyWork(s), true);
});
test("Others REMAINING blocks submit until text entered or No Plan (Others compulsory)", () => {
  const s = statusesFor({ SALES: true, RECOVERY: true, APPOINTMENT: true, SCHEME_CONVERSION: true, VISITS: true, OTHERS: false }, []);
  assert.equal(s.OTHERS, SectionStatus.REMAINING);
  assert.equal(canSubmitDailyWork(s), false, "cannot submit while Others is unresolved");
  assert.equal(canSubmitDailyWork(statusesFor({ SALES: true, RECOVERY: true, APPOINTMENT: true, SCHEME_CONVERSION: true, VISITS: true, OTHERS: true }, [])), true, "Others text resolves it");
  assert.equal(canSubmitDailyWork(statusesFor({ SALES: true, RECOVERY: true, APPOINTMENT: true, SCHEME_CONVERSION: true, VISITS: true, OTHERS: false }, ["OTHERS"])), true, "Others No Plan resolves it");
});
test("5) mixed Filled + No Plan, all resolved → submit ENABLED (spec example 2)", () => {
  const s = statusesFor({ SALES: true, RECOVERY: false, APPOINTMENT: true, SCHEME_CONVERSION: false, VISITS: true, OTHERS: true }, ["RECOVERY", "SCHEME_CONVERSION"]);
  assert.deepEqual(sectionStatusCounts(s), { filled: 4, noPlan: 1, remaining: 0, total: 5 });
  assert.equal(canSubmitDailyWork(s), true);
});
test("6) any one section Remaining → submit DISABLED (spec example 3)", () => {
  const s = statusesFor({ SALES: true, RECOVERY: true, APPOINTMENT: false, SCHEME_CONVERSION: true, VISITS: true, OTHERS: true }, []);
  assert.equal(s.APPOINTMENT, SectionStatus.REMAINING);
  assert.equal(canSubmitDailyWork(s), false);
});
test("4b) all 5 active sections No Plan → submit ENABLED (spec example 4)", () => {
  const s = statusesFor(noData, ["SALES", "RECOVERY", "APPOINTMENT", "SCHEME_CONVERSION", "VISITS", "OTHERS"]);
  assert.deepEqual(sectionStatusCounts(s), { filled: 0, noPlan: 5, remaining: 0, total: 5 });
  assert.equal(canSubmitDailyWork(s), true);
});
test("No Plan + data ⇒ the section is FILLED, not NO_PLAN (stale flag never surfaces)", () => {
  const s = statusesFor({ ...noData, SALES: true }, ["SALES"]);
  assert.equal(s.SALES, SectionStatus.FILLED);
});
test("No-Plan CSV round-trips and keeps only mandatory names in canonical order", () => {
  const parsed = [...parseNoPlanSet("VISITS,SALES,OTHERS,bogus")];
  assert.equal(parsed.length, 3, JSON.stringify(parsed));
  assert.ok(parsed.includes("SALES") && parsed.includes("VISITS") && parsed.includes("OTHERS"), "only mandatory names kept (Others now mandatory)");
  assert.equal(serializeNoPlanSet(new Set(["VISITS", "SALES", "OTHERS"])), "SALES,VISITS,OTHERS"); // canonical order
  assert.equal(serializeNoPlanSet(new Set()), "");
});

/* ---------- Task Type (Daily Plan) — derived from the Auto Task contribution link ---------- */
// A row's Task Type is AUTO iff it carries a materialized Auto Task contribution, else MANUAL. The four sections
// map onto this: Sales/Appointment/Conversion have no Auto Task source (always MANUAL); Recovery is AUTO when a
// materialized CN task is linked. These pure helpers back all four section tables.
test("rowTaskType: Auto Task contribution present → AUTO; absent → MANUAL", () => {
  assert.equal(rowTaskType(true), "AUTO");
  assert.equal(rowTaskType(false), "MANUAL");
});
test("1-8) per-section rows: manual → Manual, auto-linked → Auto Task", () => {
  // Sales/Appointment/Conversion never have an Auto Task source → Manual for their existing manual rows.
  assert.equal(rowTaskType(false), "MANUAL", "manual Sales row");
  assert.equal(rowTaskType(false), "MANUAL", "manual Recovery row");
  assert.equal(rowTaskType(false), "MANUAL", "manual Dealer Appointment row");
  assert.equal(rowTaskType(false), "MANUAL", "manual Scheme Conversion row");
  // Only Recovery currently produces an Auto Task contribution; a linked row derives AUTO.
  assert.equal(rowTaskType(true), "AUTO", "auto Recovery row");
});
test("10) multiple Auto Task contributions on one row still → AUTO", () => {
  // The row-level flag is "has at least one Auto Task contribution", so 2+ contributions remain AUTO.
  const hasAuto = [24_000, 5_000].length > 0;
  assert.equal(rowTaskType(hasAuto), "AUTO");
});
test("11) rescheduling the last Auto Task contribution away → MANUAL", () => {
  // After the only contribution is reversed, the link is gone → the row is Manual (manual data may remain).
  const remainingAutoContributions = 0;
  assert.equal(rowTaskType(remainingAutoContributions > 0), "MANUAL");
});
test("12) rescheduling one of several Auto Tasks → still AUTO", () => {
  const remainingAutoContributions = 1; // one reversed, one remains linked
  assert.equal(rowTaskType(remainingAutoContributions > 0), "AUTO");
});
test("9) combined Task Type is always neutral because Task Type is dealer-level", () => {
  const auto: TaskType = "AUTO", manual: TaskType = "MANUAL";
  assert.equal(combineTaskType([auto, auto]), null);
  assert.equal(combineTaskType([manual, manual]), null);
  assert.equal(combineTaskType([auto, manual]), null);
  assert.equal(combineTaskType([]), null);
});
test("Task Type is the second column in all four dealer-based Daily Plan tables", () => {
  const page = readFileSync(resolve("src/features/daily-work/daily-work-page.tsx"), "utf8");
  const section = (start: string, end: string) => page.slice(page.indexOf(start), page.indexOf(end));
  const header = (source: string) => source.slice(source.indexOf("<TableHeader>"), source.indexOf("</TableHeader>"));
  const assertSecond = (source: string, thirdColumn: string, name: string) => {
    const tableHeader = header(source);
    const dealer = tableHeader.indexOf("{L.dealer}");
    const taskType = tableHeader.indexOf("{L.taskType}");
    const third = tableHeader.indexOf(thirdColumn);
    assert.ok(dealer >= 0 && dealer < taskType && taskType < third, `${name}: Dealer → Task Type → next column`);
  };

  const salesRecovery = section("function DailyWorkSection(", "function MaterializedTaskRescheduleDialog(");
  assertSecond(salesRecovery, "{L.plan}", "Sales");
  assertSecond(salesRecovery, "{L.plan}", "Recovery");
  assertSecond(section("function AppointmentSection(", "function ConversionSection("), "{L.market}", "Dealer Appointment");
  assertSecond(section("function ConversionSection(", "function SummarySection("), "{L.scheme}", "Scheme Conversion");
});
test("combined rows render neutral labels for dealer-level fields while individual rows retain their values", () => {
  const page = readFileSync(resolve("src/features/daily-work/daily-work-page.tsx"), "utf8");
  const section = (start: string, end: string) => page.slice(page.indexOf(start), page.indexOf(end));

  const salesRecovery = section("function DailyWorkSection(", "function MaterializedTaskRescheduleDialog(");
  assert.match(salesRecovery, /<TableCell>\{combined\.dealerLabel\}<\/TableCell>\s*\{showTaskType && <TableCell>\{L\.none\}<\/TableCell>\}/);
  assert.match(salesRecovery, /money\(combined\.todaysPlan\)[\s\S]*?<TableCell>\{L\.none\}<\/TableCell>/, "Sales/Recovery Type summary is neutral");
  assert.match(salesRecovery, /taskTypeText\(rowTaskTypeOf\(r\.dealerId\), taskTypeL\)/, "individual Task Type stays derived");
  assert.match(salesRecovery, /options=\{typeOptions\}/, "individual Sales/Recovery Type stays selectable");

  const appointment = section("function AppointmentSection(", "function ConversionSection(");
  assert.match(appointment, /<TableCell>\{combined\.dealerLabel\}<\/TableCell>\s*\{showTaskType && <TableCell>\{L\.none\}<\/TableCell>}\s*<TableCell>\{L\.none\}<\/TableCell>/, "Task Type and Market summaries are neutral");
  assert.match(appointment, /taskTypeText\(rowTaskType\(false, \(data\?\.calendarEntryIds \?\? \[\]\)\.includes\(r\.entryId\)\), taskTypeL\)/, "individual appointment Task Type is Calendar (from a Calendar task) or Manual");

  const conversion = section("function ConversionSection(", "function SummarySection(");
  assert.match(conversion, /<TableCell>\{combined\.dealerLabel\}<\/TableCell>\s*\{showTaskType && <TableCell>\{L\.none\}<\/TableCell>}\s*<TableCell>\{L\.none\}<\/TableCell>/, "Task Type and Scheme summaries are neutral");
  assert.match(conversion, /taskTypeText\(rowTaskType\(false\), taskTypeL\)/, "individual conversion Task Type stays Manual");
});
test("13) derived Task Type is stable across reloads (pure function of the source flag)", () => {
  // Same source flag yields the same result every render/reload — no hidden state.
  for (const hasAuto of [true, false, true]) assert.equal(rowTaskType(hasAuto), hasAuto ? "AUTO" : "MANUAL");
});

/* ---------- Daily Plan / Daily Report view separation ---------- */
test("Daily Plan is the default view and hides result columns", () => {
  assert.equal(DEFAULT_DAILY_WORK_VIEW, DailyWorkView.PLAN);
  assert.equal(dailyWorkShowsResults(DEFAULT_DAILY_WORK_VIEW), false);
});
test("Daily Report is selectable and shows result columns", () => {
  assert.equal(dailyWorkShowsResults(DailyWorkView.REPORT), true);
});
test("Daily Report includes submitted rows and excludes draft/new rows", () => {
  const rows = [
    { id: "submitted", status: "SUBMITTED" },
    { id: "draft", status: "DRAFT" },
    { id: "new", status: "NEW" },
  ];
  assert.deepEqual(
    visibleDailyWorkRows(rows, DailyWorkView.REPORT, (row) => row.status === "SUBMITTED").map((row) => row.id),
    ["submitted"],
  );
  assert.deepEqual(
    visibleDailyWorkRows(rows, DailyWorkView.PLAN, (row) => row.status === "SUBMITTED").map((row) => row.id),
    ["submitted", "draft", "new"],
  );
});
test("switching views filters presentation without replacing Daily Work row state", () => {
  const rows = [{ id: "submitted", status: "SUBMITTED", value: 8 }, { id: "draft", status: "DRAFT", value: 10 }];
  const report = visibleDailyWorkRows(rows, DailyWorkView.REPORT, (row) => row.status === "SUBMITTED");
  const planAgain = visibleDailyWorkRows(rows, DailyWorkView.PLAN, (row) => row.status === "SUBMITTED");
  assert.equal(report[0], rows[0], "report uses the existing submitted row object");
  assert.equal(planAgain[1], rows[1], "draft state is still present after switching back");
  assert.equal(rows[1].value, 10);
});
test("Daily Plan and Daily Report labels are registered in the existing label system", () => {
  assert.equal(DEFAULT_LABELS["daily_work.view.plan"], "Daily Plan");
  assert.equal(DEFAULT_LABELS["daily_work.view.report"], "Daily Report");
  assert.ok(labelCatalog({}).some((entry) => entry.key === "daily_work.view.plan"));
  assert.ok(labelCatalog({}).some((entry) => entry.key === "daily_work.view.report"));
});

/* ---------- Payment Mode follows the ACTUAL recovery amount (Daily Report) ---------- */
test("Payment Mode applies only to a positive numeric Today's Recovery", () => {
  for (const v of [25000, "25000", 0.01, "0.5"]) assert.equal(paymentModeApplies(v), true, String(v));
  for (const v of [0, "0", -1, "-5", "", "  ", null, undefined, "abc", NaN, Infinity * -1]) assert.equal(paymentModeApplies(v), false, String(v));
  assert.equal(paymentModeApplies("₹25,000"), false, "a formatted currency string is never treated as the amount");
});
test("Payment Mode is kept for a positive recovery and cleared otherwise", () => {
  assert.equal(paymentModeForActual(10000, "UPI"), "UPI");
  assert.equal(paymentModeForActual(10000, null), null);
  for (const v of [0, "0", -5, "", null]) assert.equal(paymentModeForActual(v, "CASH"), null, String(v));
});
test("Daily Plan source never wires Payment Mode", () => {
  const page = readFileSync(resolve("src/features/daily-work/daily-work-page.tsx"), "utf8");
  assert.doesNotMatch(page, /paymentMode: r\.paymentMode \}/, "the Plan payload carries no Payment Mode");
  const service = readFileSync(resolve("src/features/daily-work/service.server.ts"), "utf8");
  assert.doesNotMatch(service, /recoveryRowSchema/, "no Recovery-specific Plan schema with Payment Mode");
});

/* ---------- Strict daily workflow: previous report gate + noon deadline ---------- */
test("previous business date is plain calendar arithmetic across month/year boundaries", () => {
  assert.equal(previousBusinessDate("2026-10-06"), "2026-10-05");
  assert.equal(previousBusinessDate("2026-10-01"), "2026-09-30");
  assert.equal(previousBusinessDate("2026-01-01"), "2025-12-31");
  assert.equal(previousBusinessDate("2024-03-01"), "2024-02-29");
  assert.equal(addBusinessDays("2026-12-31", 1), "2027-01-01");
});
test("the Daily Report deadline is 12:00 noon of the NEXT day in the Daily Work business timezone (IST)", () => {
  assert.equal(dailyReportDeadline("2026-10-05").toISOString(), "2026-10-06T06:30:00.000Z"); // 12:00 IST = 06:30 UTC
  assert.equal(dailyReportDeadline("2026-12-31").toISOString(), "2027-01-01T06:30:00.000Z");
  assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(dailyReportDeadline("2026-10-05")), "12:00");
});
test("deadline boundary: noon is allowed, anything after is late; earlier days are long past", () => {
  const d = "2026-10-05";
  assert.equal(isReportDeadlinePassed(d, new Date("2026-10-06T11:59:59+05:30")), false);
  assert.equal(isReportDeadlinePassed(d, new Date("2026-10-06T12:00:00.000+05:30")), false, "exactly 12:00:00 is still on time");
  assert.equal(isReportDeadlinePassed(d, new Date("2026-10-06T12:00:00.001+05:30")), true);
  assert.equal(isReportDeadlinePassed(d, new Date("2026-10-06T12:01:00+05:30")), true);
  assert.equal(isReportDeadlinePassed(d, new Date("2026-10-05T23:59:00+05:30")), false, "the same evening is within the window");
  // Timezone-independent: the same instant expressed in UTC / US time gives the same answer.
  assert.equal(isReportDeadlinePassed(d, new Date("2026-10-06T06:30:01Z")), true);
  assert.equal(isReportDeadlinePassed(d, new Date("2026-10-06T01:00:00-05:30")), false);
});
test("previous report state: NOT_APPLICABLE / SUBMITTED / PENDING / MISSED — only PENDING blocks today's plan", () => {
  const prev = "2026-10-05", before = new Date("2026-10-06T10:00:00+05:30"), after = new Date("2026-10-06T12:01:00+05:30");
  assert.equal(previousReportState({ planned: false, finalized: false }, prev, after), "NOT_APPLICABLE");
  assert.equal(previousReportState({ planned: false, finalized: false }, prev, before), "NOT_APPLICABLE", "no plan → never pending/missed");
  assert.equal(previousReportState({ planned: true, finalized: true }, prev, after), "SUBMITTED", "a submitted report never becomes Missed");
  assert.equal(previousReportState({ planned: true, finalized: false }, prev, before), "PENDING");
  assert.equal(previousReportState({ planned: true, finalized: false }, prev, new Date("2026-10-06T12:00:00.000+05:30")), "PENDING", "noon itself is still on time");
  assert.equal(previousReportState({ planned: true, finalized: false }, prev, after), "MISSED");
  assert.deepEqual((["NOT_APPLICABLE", "SUBMITTED", "PENDING", "MISSED"] as const).map(previousReportBlocksPlan), [false, false, true, false]);
});
test("Missed is derived from plan + not finalized + deadline, never stored", () => {
  const d = "2026-10-05";
  assert.equal(isReportMissed(d, true, false, new Date("2026-10-06T12:01:00+05:30")), true);
  assert.equal(isReportMissed(d, true, false, new Date("2026-10-06T11:59:00+05:30")), false, "not Missed before the deadline");
  assert.equal(isReportMissed(d, true, true, new Date("2026-10-09T09:00:00+05:30")), false, "finalized never Missed");
  assert.equal(isReportMissed(d, false, false, new Date("2026-10-09T09:00:00+05:30")), false, "no plan → nothing to miss");
});
test("report date: today, or yesterday (while its deadline is open); anything else falls back to today", () => {
  const now = new Date("2026-10-06T10:00:00+05:30");
  assert.equal(resolveReportDate("2026-10-05", now), "2026-10-05");
  assert.equal(resolveReportDate("2026-10-06", now), "2026-10-06");
  for (const other of ["2026-10-04", "2026-10-07", "2025-01-01", "junk", undefined, null, 5]) assert.equal(resolveReportDate(other, now), "2026-10-06");
  assert.equal(resolveReportDate("2026-10-05", new Date("2026-10-06T23:30:00+05:30")), "2026-10-05", "business date, not UTC");
});
test("Submit Daily Work shows why it is blocked, and the Report shows its deadline", () => {
  const page = readFileSync(resolve("src/features/daily-work/daily-work-page.tsx"), "utf8");
  assert.match(page, /previousReport\?\.state === "PENDING"/);
  assert.doesNotMatch(page, /EXPIRED/, "a Missed report shows no blocking message");
  assert.match(page, /data\.reportDeadlinePassed/);
  const service = readFileSync(resolve("src/features/daily-work/service.server.ts"), "utf8");
  assert.ok(service.includes("previousReportBlocksPlan(previous.state)"), "canSubmit is also false while blocked (server authoritative)");
});

/* ---------- Today's Plan must be strictly greater than 0 (Sales + Recovery rows) ---------- */
test("Today's Plan: only a real number > 0 is valid", () => {
  for (const v of [1, 0.01, 10000, "1", "250.5", " 7 "]) assert.equal(isValidTodaysPlan(v), true, String(v));
  for (const v of [0, "0", "0.00", -1, "-100", "", "  ", null, undefined, NaN, Infinity, -Infinity, "abc", "₹100", {}, [], true]) assert.equal(isValidTodaysPlan(v), false, String(v));
});
test("invalidPlanRows names every failing (section, dealer) and checks the same dealer once per section", () => {
  const rows = [
    { section: "SALES" as const, dealerId: "d1", dealerName: "A", todaysPlan: 100 },
    { section: "SALES" as const, dealerId: "d2", dealerName: "B", todaysPlan: 0 },
    { section: "RECOVERY" as const, dealerId: "d1", dealerName: "A", todaysPlan: "" },
    { section: "RECOVERY" as const, dealerId: "d3", dealerName: "C", todaysPlan: -5 },
    { section: "RECOVERY" as const, dealerId: "d4", dealerName: "D", todaysPlan: 5000 },
  ];
  assert.deepEqual(invalidPlanRows(rows).map((r) => `${r.section}:${r.dealerId}`), ["SALES:d2", "RECOVERY:d1", "RECOVERY:d3"]);
  assert.deepEqual(invalidPlanRows([]), [], "no rows → nothing to validate");
  assert.equal(
    planRequiredMessage("Please enter a Today's Plan greater than 0 for:\n{rows}", invalidPlanRows(rows).slice(0, 2), { SALES: "Sales", RECOVERY: "Recovery" }),
    "Please enter a Today's Plan greater than 0 for:\n- Sales — B\n- Recovery — A",
  );
});

console.log(`\n${passed} daily-work helper tests passed`);
