/**
 * Operational Calendar projection tests (`calendar.ts`). DB-free.
 *   npx tsx src/lib/calendar.test.ts
 */
import assert from "node:assert/strict";
import {
  dateKey, monthRange, upcomingRange, isUpcoming, conversionEventStatus,
  projectConversionEvents, groupEventsByOfficer, type ConversionEventInput,
  projectPartyAppointmentEvents, type PartyAppointmentInput,
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

/* ---------- Party Appointment projection (Phase 2) ---------- */
const party = (over: Partial<PartyAppointmentInput> = {}): PartyAppointmentInput => ({
  id: "pp1", partyName: "ABC Traders", marketName: "Bhopal", appointmentDate: "2026-09-22",
  salesOfficerId: "so1", salesOfficerName: "Subham Yadav", ...over,
});

test("Party: one event on the exact appointment date with Party Name + Market", () => {
  const [e] = projectPartyAppointmentEvents([party()]);
  assert.equal(e.type, "PARTY_APPOINTMENT");
  assert.equal(e.dateKey, "2026-09-22", "appointment date used exactly");
  assert.equal(e.partyName, "ABC Traders");
  assert.equal(e.marketName, "Bhopal");
  assert.equal(e.salesOfficerId, "so1");
});
test("Party: appointment date does NOT shift by timezone (business date preserved)", () => {
  // A Date at UTC midnight and a plain string must both yield the same yyyy-mm-dd.
  const [fromString] = projectPartyAppointmentEvents([party({ appointmentDate: "2026-09-22" })]);
  const [fromDate] = projectPartyAppointmentEvents([party({ appointmentDate: new Date("2026-09-22T00:00:00.000Z") })]);
  assert.equal(fromString.dateKey, "2026-09-22");
  assert.equal(fromDate.dateKey, "2026-09-22");
});
test("Party: a plan with no appointment date produces no event", () => {
  assert.equal(projectPartyAppointmentEvents([party({ appointmentDate: null })]).length, 0);
});
test("Party: a plan with no Market still projects (Market optional in display)", () => {
  const [e] = projectPartyAppointmentEvents([party({ marketName: null })]);
  assert.equal(e.partyName, "ABC Traders");
  assert.equal(e.marketName, null);
});
test("Party: multiple appointments on the SAME day are all projected", () => {
  const events = projectPartyAppointmentEvents([
    party({ id: "a", partyName: "ABC Traders", appointmentDate: "2026-09-22" }),
    party({ id: "b", partyName: "XYZ Traders", appointmentDate: "2026-09-22" }),
  ]);
  assert.equal(events.length, 2);
  assert.deepEqual(events.filter((e) => e.dateKey === "2026-09-22").map((e) => e.partyName).sort(), ["ABC Traders", "XYZ Traders"]);
});
test("Party: same approved plan projects EXACTLY ONE event (no duplication)", () => {
  const events = projectPartyAppointmentEvents([party({ id: "pp1" })]);
  assert.equal(events.length, 1, "one row → one event; derivation is idempotent");
});
test("Party: events group by Sales Officer for the Admin/RM view", () => {
  const events = projectPartyAppointmentEvents([
    party({ id: "a", salesOfficerId: "so2", salesOfficerName: "Rahul Patidar", partyName: "P2" }),
    party({ id: "b", salesOfficerId: "so1", salesOfficerName: "Subham Yadav", partyName: "P1" }),
  ]);
  const groups = groupEventsByOfficer(events);
  assert.deepEqual(groups.map((g) => g.salesOfficerName), ["Rahul Patidar", "Subham Yadav"]);
});
test("Party + Conversion can share a date without interfering", () => {
  const conv = projectConversionEvents([plan({ expectedBillingDate: "2026-09-22" })]);
  const parties = projectPartyAppointmentEvents([party({ appointmentDate: "2026-09-22" })]);
  assert.equal(conv.length, 1);
  assert.equal(parties.length, 1);
  assert.equal(conv[0].type, "CONVERSION");
  assert.equal(parties[0].type, "PARTY_APPOINTMENT");
  // Distinct event streams — one does not overwrite or absorb the other.
  assert.notEqual(conv[0].type, parties[0].type);
});

console.log(`\n${passed} calendar projection tests passed`);
