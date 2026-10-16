/**
 * Operational Calendar projection tests (`calendar.ts`). DB-free.
 *   npx tsx src/lib/calendar.test.ts
 */
import assert from "node:assert/strict";
import {
  dateKey, monthRange, upcomingRange, isUpcoming, conversionEventStatus,
  projectConversionEvents, groupEventsByOfficer, type ConversionEventInput,
  projectPartyAppointmentEvents, type PartyAppointmentInput, groupDayByEmployee, taskSubtype, employeeHeaderText, orderedDayItems, dayTotals,
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

test("one selected day is grouped by EMPLOYEE across every source, sorted by name, with entry counts", () => {
  const day = {
    events: [{ salesOfficerId: "u2", salesOfficerName: "Rahul" }],
    partyEvents: [{ salesOfficerId: "u2", salesOfficerName: "Rahul" }],
    billingTasks: [{ ownerId: "u1", ownerName: "Amit" }, { ownerId: "u2", ownerName: "Rahul" }],
    entries: [{ ownerId: "u1", ownerName: "Amit" }, { ownerId: "u3", ownerName: "Zoya" }],
    notes: [{ ownerId: "u1", ownerName: "Amit" }],
  };
  const groups = groupDayByEmployee(day);
  assert.deepEqual(groups.map((g) => [g.employeeName, g.count]), [["Amit", 3], ["Rahul", 3], ["Zoya", 1]]);
  assert.deepEqual(groups.map((g) => g.events.length + g.partyEvents.length + g.billingTasks.length + g.entries.length + g.notes.length), groups.map((g) => g.count), "count = entries in the group");
  assert.equal(groups.reduce((n, g) => n + g.count, 0), 7, "nothing dropped, nothing duplicated");
  assert.deepEqual(groupDayByEmployee({ events: [], partyEvents: [], billingTasks: [], entries: [], notes: [] }), [], "an empty day has no groups");
  // regrouping never reveals anything the server did not send: only the given rows appear
  assert.equal(groups.flatMap((g) => g.notes).length, 1);
});

test("task subtype is the REAL classification: Regular | Scheme for Sales / Recovery, the generating source for Auto tasks, none elsewhere", () => {
  assert.equal(taskSubtype("RECOVERY", "REGULAR", null), "REGULAR");
  assert.equal(taskSubtype("RECOVERY", "SCHEME", null), "SCHEME");
  assert.equal(taskSubtype("SALES", "SCHEME", null), "SCHEME");
  assert.equal(taskSubtype("RECOVERY", null, null), "REGULAR", "a row without a stored classification is the regular one");
  assert.equal(taskSubtype("RECOVERY", "REGULAR", "BILLING_EXCEPTION"), "BILLING_EXCEPTION", "the generating source wins for an Auto task");
  assert.equal(taskSubtype("RECOVERY", null, "CN_REQUEST"), "CN_REQUEST");
  for (const section of ["VISITS", "OTHERS", "APPOINTMENT"]) assert.equal(taskSubtype(section, "REGULAR", null), null, `${section} has no subtype (no brackets)`);
});

test("employee header: Name [Territory] State; missing parts (and their brackets) are left out, never 'undefined'", () => {
  assert.equal(employeeHeaderText("Suresh Verma", "Raigarh", "CG"), "Suresh Verma [Raigarh] CG");
  assert.equal(employeeHeaderText("Suresh Verma", null, "CG"), "Suresh Verma CG");
  assert.equal(employeeHeaderText("Suresh Verma", "Raigarh", null), "Suresh Verma [Raigarh]");
  assert.equal(employeeHeaderText("Suresh Verma", undefined, undefined), "Suresh Verma");
  assert.equal(employeeHeaderText("Suresh Verma", "  ", ""), "Suresh Verma");
  assert.equal(employeeHeaderText("Suresh Verma", "undefined", "null"), "Suresh Verma");
  assert.equal(employeeHeaderText("Suresh Verma", "  Raigarh   City ", " CG "), "Suresh Verma [Raigarh City] CG");
});

test("one numbered list per employee: deterministic order, nothing merged, the same record twice is one item", () => {
  const e = (id: string, kind: string, at: string, over: Record<string, unknown> = {}) => ({ id, kind, ownerId: "so1", ownerName: "Amit", createdAt: at, task: kind === "TASK" ? { section: "RECOVERY", dealerId: "d1", amount: 100 } : null, ...over });
  // three tasks with the SAME dealer / section / amount are three separate tasks; arrival order must not matter
  const entries = [e("t3", "TASK", "2026-10-01T10:00:03Z"), e("r1", "REMINDER", "2026-10-01T09:00:00Z"), e("t1", "TASK", "2026-10-01T10:00:01Z"), e("t2", "TASK", "2026-10-01T10:00:02Z")];
  const billing = [{ id: "b1", ownerId: "so1", ownerName: "Amit" }];
  const notes = [{ id: "n1", ownerId: "so1", ownerName: "Amit", createdAt: "2026-10-01T08:00:00Z" }];
  const events = [{ planId: "c1", salesOfficerId: "so1", salesOfficerName: "Amit" }];
  const order = (input: typeof entries) => orderedDayItems(groupDayByEmployee({ events, partyEvents: [], billingTasks: billing, entries: input, notes })[0]!).map((i) => `${i.type}:${i.id}`);
  const a = order(entries), b = order([...entries].reverse());
  assert.deepEqual(a, ["event:c1", "billing:b1", "task:t1", "task:t2", "task:t3", "entry:r1", "note:n1"]);
  assert.deepEqual(b, a, "a different arrival order gives the same numbering");
  const dup = groupDayByEmployee({ events: [], partyEvents: [], billingTasks: [{ id: "b1", ownerId: "so1", ownerName: "Amit" }, { id: "b1", ownerId: "so1", ownerName: "Amit" }], entries: [e("t1", "TASK", "x"), e("t1", "TASK", "x"), e("t2", "TASK", "x")], notes: [] });
  assert.equal(dup[0]!.count, 3, "the same underlying task (twice) counts once; the genuinely separate task stays");
  const two = groupDayByEmployee({ events: [], partyEvents: [], billingTasks: [], entries: [e("a", "TASK", "x", { ownerId: "so1", ownerName: "Same Name" }), e("b", "TASK", "x", { ownerId: "so2", ownerName: "Same Name" })], notes: [] });
  assert.deepEqual(two.map((g) => [g.employeeId, g.count]), [["so1", 1], ["so2", 1]], "employees with identical names stay separate (stable user ids)");
});

test("day totals: distinct Sales Officers with a visible item, and all distinct items — an Admin's / RM's own reminder is not an SO", () => {
  const role = (id: string) => ({ so1: "SALES_OFFICER", so2: "SALES_OFFICER", admin: "SUPER_ADMIN", rm1: "REGIONAL_MANAGER" } as Record<string, string>)[id];
  assert.deepEqual(dayTotals([{ employeeId: "so1", count: 3 }, { employeeId: "so2", count: 2 }], role), { officers: 2, tasks: 5 });
  assert.deepEqual(dayTotals([{ employeeId: "so1", count: 3 }, { employeeId: "admin", count: 1 }, { employeeId: "rm1", count: 2 }], role), { officers: 1, tasks: 6 }, "Admin / RM items add to the tasks, not to No of SO");
  assert.deepEqual(dayTotals([], role), { officers: 0, tasks: 0 }, "an empty date is zero");
  assert.deepEqual(dayTotals([{ employeeId: "so1", count: 0 }], role), { officers: 0, tasks: 0 });
});

console.log(`\n${passed} calendar projection tests passed`);
