/**
 * Operational Calendar projection tests (`calendar.ts`). DB-free.
 *   npx tsx src/lib/calendar.test.ts
 */
import assert from "node:assert/strict";
import {
  dateKey, monthRange, upcomingRange, isUpcoming, conversionEventStatus,
  projectConversionEvents, groupEventsByOfficer, type ConversionEventInput,
} from "./calendar";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }

const plan = (over: Partial<ConversionEventInput> = {}): ConversionEventInput => ({
  id: "p1", schemeId: "s1", expectedBillingDate: "2026-09-15", dealerName: "Anand KSK Harda",
  schemeName: "Fasal Vriddhi Scheme", numberOfSchemes: 1, totalSchemeAmount: 585000,
  salesOfficerId: "so1", salesOfficerName: "Subham Yadav", planStatus: "DRAFT", schemeStatus: "PENDING",
  enrollmentStatus: "PENDING_DOCUMENT", conversionExtensionCount: 0, originalConversionDate: "2026-09-15", ...over,
});

/* ---------- Generation ---------- */
test("Generation: one event on the correct date with dealer/count/amount", () => {
  const [e] = projectConversionEvents([plan()]);
  assert.equal(e.dateKey, "2026-09-15");
  assert.equal(e.dealerName, "Anand KSK Harda");
  assert.equal(e.numberOfSchemes, 1);
  assert.equal(e.totalSchemeAmount, 585000);
  assert.equal(e.type, "CONVERSION");
});
test("Generation: a plan with NO conversion date produces no event", () => {
  assert.equal(projectConversionEvents([plan({ expectedBillingDate: null })]).length, 0);
});
test("Generation: Draft plans DO appear (activity timeline, not pending-only)", () => {
  assert.equal(projectConversionEvents([plan({ planStatus: "DRAFT" })]).length, 1);
});

/* ---------- Date change (extension) ---------- */
test("Date change: event is on the CURRENT date, flagged changed, original preserved", () => {
  // Original 15 Sep, extended to 18 Sep: expectedBillingDate moved, originalConversionDate is the baseline.
  const [e] = projectConversionEvents([plan({ expectedBillingDate: "2026-09-18", originalConversionDate: "2026-09-15", conversionExtensionCount: 1 })]);
  assert.equal(e.dateKey, "2026-09-18", "active event on the new date");
  assert.equal(e.dateChanged, true, "date-changed indicator");
  assert.equal(e.originalDateKey, "2026-09-15", "previous/baseline date available");
});
test("Date change: no active duplicate on the old date", () => {
  const events = projectConversionEvents([plan({ expectedBillingDate: "2026-09-18", conversionExtensionCount: 1 })]);
  assert.equal(events.length, 1);
  assert.equal(events.filter((e) => e.dateKey === "2026-09-15").length, 0);
});

/* ---------- Status derivation ---------- */
test("Status: derives Planned/Submitted/Approved/Converted/Enrolled/Declined from existing fields", () => {
  assert.equal(conversionEventStatus({ planStatus: "DRAFT", schemeStatus: "PENDING" }), "PLANNED");
  assert.equal(conversionEventStatus({ planStatus: "PENDING_RM", schemeStatus: "PENDING" }), "SUBMITTED");
  assert.equal(conversionEventStatus({ planStatus: "PENDING_APPROVAL", schemeStatus: "PENDING" }), "SUBMITTED");
  assert.equal(conversionEventStatus({ planStatus: "APPROVED", schemeStatus: "PENDING" }), "APPROVED");
  assert.equal(conversionEventStatus({ planStatus: "APPROVED", schemeStatus: "CONVERTED" }), "CONVERTED");
  assert.equal(conversionEventStatus({ planStatus: "APPROVED", schemeStatus: "CONVERTED", enrollmentStatus: "ENROLLED" }), "ENROLLED");
  assert.equal(conversionEventStatus({ planStatus: "APPROVED", schemeStatus: "DECLINED" }), "DECLINED");
});

/* ---------- Multiple dealers / schemes ---------- */
test("Multiple dealers land on their own dates with correct schemes/amount", () => {
  const events = projectConversionEvents([
    plan({ id: "a", dealerName: "Gothi Fertilizer Itarsi", expectedBillingDate: "2026-09-15", numberOfSchemes: 4, totalSchemeAmount: 2340000 }),
    plan({ id: "b", dealerName: "BABA TRADERS", expectedBillingDate: "2026-09-17", numberOfSchemes: 3, totalSchemeAmount: 1755000 }),
  ]);
  const byDate = Object.fromEntries(events.map((e) => [e.dateKey, e]));
  assert.equal(byDate["2026-09-15"].numberOfSchemes, 4);
  assert.equal(byDate["2026-09-15"].totalSchemeAmount, 2340000);
  assert.equal(byDate["2026-09-17"].dealerName, "BABA TRADERS");
  assert.equal(byDate["2026-09-17"].totalSchemeAmount, 1755000);
});

/* ---------- Admin grouping by officer ---------- */
test("Admin grouping: events grouped by Sales Officer (sorted by name)", () => {
  const events = projectConversionEvents([
    plan({ id: "a", salesOfficerId: "so2", salesOfficerName: "Rahul Patidar", dealerName: "BABA TRADERS" }),
    plan({ id: "b", salesOfficerId: "so1", salesOfficerName: "Subham Yadav", dealerName: "Gothi Fertilizer" }),
    plan({ id: "c", salesOfficerId: "so1", salesOfficerName: "Subham Yadav", dealerName: "Maruti Enterprises" }),
  ]);
  const groups = groupEventsByOfficer(events);
  assert.deepEqual(groups.map((g) => g.salesOfficerName), ["Rahul Patidar", "Subham Yadav"]);
  assert.equal(groups.find((g) => g.salesOfficerId === "so1")!.events.length, 2);
});

/* ---------- Upcoming window ---------- */
test("Upcoming: today included, past excluded, day 5 within 5-day window, day 6 excluded", () => {
  const todayKey = "2026-09-15";
  assert.equal(isUpcoming("2026-09-15", todayKey, 5), true, "today");
  assert.equal(isUpcoming("2026-09-14", todayKey, 5), false, "yesterday excluded");
  assert.equal(isUpcoming("2026-09-19", todayKey, 5), true, "within window (diff 4)");
  assert.equal(isUpcoming("2026-09-20", todayKey, 5), false, "diff 5 excluded (window is [today, +5))");
});
test("upcomingRange: half-open [today, today+days)", () => {
  const { gte, lt } = upcomingRange(new Date("2026-09-15T09:30:00Z"), 5);
  assert.equal(dateKey(gte), "2026-09-15");
  assert.equal(dateKey(lt), "2026-09-20");
});
test("monthRange: whole month half-open", () => {
  const { gte, lt } = monthRange(2026, 9);
  assert.equal(dateKey(gte), "2026-09-01");
  assert.equal(dateKey(lt), "2026-10-01");
});

console.log(`\n${passed} calendar projection tests passed`);
