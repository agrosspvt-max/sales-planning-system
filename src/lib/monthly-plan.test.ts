/** Pure Monthly Planning rules: the ROW status workflow, payload validation, month / plan-date checks. */
import assert from "node:assert/strict";
import { conversionDays, daysBetween, displayRowStatus, summarizeDateHistory, monthlySheetStatus, ROW_STATUSES, ROW_STATUS_LABEL, TRANSITIONS, adminActionFor, parseDocInfo, parseTransition, transitionActor, validatePartyName, validatePlanDate } from "./monthly-plan";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

test("one row-level lifecycle: forward moves only, Appointed and Rejected are terminal, labels are consistent", () => {
  assert.deepEqual([...ROW_STATUSES], ["NONE", "DOC_SENT", "DOC_RECEIVED", "SD_BOUNCE", "APPOINTED", "REJECTED"]);
  const rank = Object.fromEntries(ROW_STATUSES.map((s, i) => [s, s === "REJECTED" ? 99 : i]));
  for (const from of ROW_STATUSES) for (const t of TRANSITIONS[from]) assert.ok(rank[t.to]! > rank[from]!, `${from} → ${t.to} must move forward`);
  assert.deepEqual(TRANSITIONS.APPOINTED, []); assert.deepEqual(TRANSITIONS.REJECTED, []);
  assert.deepEqual(Object.values(ROW_STATUS_LABEL), ["Approved", "Doc Send By SO", "Doc Received", "SD Bounce", "Appointed", "Rejected"]);
});

test("only None → Doc Send By SO is the owner's step; every other move is an Admin step", () => {
  assert.equal(transitionActor("NONE", "DOC_SENT"), "OWNER");
  for (const from of ROW_STATUSES) for (const t of TRANSITIONS[from]) if (!(from === "NONE" && t.to === "DOC_SENT")) assert.equal(t.actor, "ADMIN", `${from} → ${t.to}`);
  assert.equal(transitionActor("DOC_SENT", "DOC_RECEIVED"), "ADMIN");
  assert.equal(transitionActor("DOC_RECEIVED", "SD_BOUNCE"), "ADMIN");
  assert.equal(transitionActor("DOC_RECEIVED", "APPOINTED"), "ADMIN");
  assert.equal(transitionActor("NONE", "REJECTED"), "ADMIN");
});

test("invalid moves do not exist (no skipping the document steps, no going back, nothing out of a terminal status)", () => {
  for (const [from, to] of [["NONE", "DOC_RECEIVED"], ["NONE", "APPOINTED"], ["NONE", "SD_BOUNCE"], ["DOC_SENT", "APPOINTED"], ["DOC_SENT", "SD_BOUNCE"], ["DOC_RECEIVED", "DOC_SENT"], ["DOC_RECEIVED", "NONE"],
    ["SD_BOUNCE", "DOC_RECEIVED"], ["APPOINTED", "REJECTED"], ["APPOINTED", "NONE"], ["REJECTED", "NONE"], ["REJECTED", "DOC_SENT"], ["NONE", "NONE"], ["X", "DOC_SENT"], ["DOC_SENT", "PART_REJECTED"]]) assert.equal(transitionActor(from!, to!), null, `${from} → ${to}`);
});

test("Admin permission: rejection → reject, every other Admin step → approve", () => {
  assert.equal(adminActionFor("REJECTED"), "reject");
  for (const s of ["DOC_RECEIVED", "SD_BOUNCE", "APPOINTED"] as const) assert.equal(adminActionFor(s), "approve");
});

test("sent / received details: at least one of Document / Check; Other is optional free text; stored as given", () => {
  assert.deepEqual(parseDocInfo({ documents: true }), { ok: true, value: { documents: true, checks: false, other: null } });
  assert.deepEqual(parseDocInfo({ checks: true, other: "  GST   certificate " }), { ok: true, value: { documents: false, checks: true, other: "GST certificate" } });
  assert.deepEqual(parseDocInfo({ documents: true, checks: true, other: "" }), { ok: true, value: { documents: true, checks: true, other: null } });
  for (const bad of [{}, null, undefined, { documents: "yes" }, { documents: false, checks: false }, { other: "text only" }, { documents: true, other: "x".repeat(501) }]) assert.equal(parseDocInfo(bad).ok, false, JSON.stringify(bad));
});

test("transition payloads: Doc Send / Received need Document or Check; SD Bounce, Appointed, Rejected take optional remarks; the browser cannot pick None", () => {
  assert.equal(parseTransition({ to: "DOC_SENT", sent: { checks: true } }).ok, true);
  assert.equal(parseTransition({ to: "DOC_SENT" }).ok, false, "Doc Send without details is refused");
  assert.equal(parseTransition({ to: "DOC_RECEIVED", received: { documents: true } }).ok, true);
  assert.equal(parseTransition({ to: "DOC_RECEIVED", sent: { documents: true } }).ok, false, "received details are not the sent details");
  for (const to of ["SD_BOUNCE", "APPOINTED", "REJECTED"]) { assert.deepEqual(parseTransition({ to }), { ok: true, value: { to, remarks: null } }, to); assert.deepEqual(parseTransition({ to, remarks: "  Cheque  returned " }), { ok: true, value: { to, remarks: "Cheque returned" } }, to); assert.equal(parseTransition({ to, remarks: "x".repeat(501) }).ok, false); }
  assert.deepEqual(parseTransition({ to: "APPOINTED", actorId: "x", appointedOn: "1999-01-01" }), { ok: true, value: { to: "APPOINTED", remarks: null } }, "extra fields (date, actor) are dropped");
  for (const to of ["NONE", "PENDING", "PART_REJECTED", "NOPE", undefined, null, 3]) assert.equal(parseTransition({ to }).ok, false, String(to));
});

test("the Status column: the operational status once begun, else the plan's own stage", () => {
  assert.equal(displayRowStatus("NONE", "DRAFT"), "Draft"); assert.equal(displayRowStatus("NONE", "REJECTED"), "Draft");
  assert.equal(displayRowStatus("NONE", "PENDING_RM"), "Submitted"); assert.equal(displayRowStatus("NONE", "PENDING_ADMIN"), "Submitted");
  assert.equal(displayRowStatus("NONE", "APPROVED"), "Approved");
  assert.equal(displayRowStatus("DOC_SENT", "APPROVED"), "Doc Send By SO"); assert.equal(displayRowStatus("APPOINTED", "APPROVED"), "Appointed");
});

test("party names and plan dates", () => {
  assert.equal(validatePartyName("ABC", true), null);
  assert.ok(validatePartyName("", true)); assert.equal(validatePartyName("", false), null); assert.ok(validatePartyName("x".repeat(201), false));
  const apr = { calendarMonth: 4, calendarYear: 2026 };
  assert.equal(validatePlanDate("2026-04-15", apr), null);
  assert.equal(validatePlanDate("", apr), null); assert.equal(validatePlanDate(null, apr), null);
  for (const bad of ["2026-05-01", "2026-03-31", "2025-04-15", "2026-02-30", "15/04/2026", 5]) assert.ok(validatePlanDate(bad, apr), String(bad));
  assert.ok(validatePlanDate("2026-04-15", { calendarMonth: null, calendarYear: null }), "a month without a calendar identity cannot validate a date");
});

test("a Monthly Plan's list status is derived from its rows' operational status", () => {
  const row = (opStatus: string) => ({ opStatus });
  assert.equal(monthlySheetStatus([]), "Draft", "a freshly created plan has no markets yet");
  assert.equal(monthlySheetStatus([row("NONE"), row("NONE")]), "In Progress");
  assert.equal(monthlySheetStatus([row("APPOINTED"), row("NONE")]), "In Progress", "one row still open");
  assert.equal(monthlySheetStatus([row("APPOINTED"), row("REJECTED")]), "Completed");
});

test("Days: Seasonal added date → Appointed date (frozen) or → today (live); never negative", () => {
  assert.equal(daysBetween("2026-10-05", "2026-10-20"), 15);
  assert.equal(daysBetween("2026-10-05", "2026-10-05"), 0);
  assert.equal(daysBetween("2026-10-20", "2026-10-05"), 0, "never negative");
  assert.equal(daysBetween("2026-02-27", "2026-03-02"), 3, "calendar days across a month end");
  assert.deepEqual(conversionDays("2026-10-05", null, "2026-10-18"), { days: 13, final: false });
  assert.deepEqual(conversionDays("2026-10-05", "2026-10-20", "2026-10-18"), { days: 15, final: true });
  assert.deepEqual(conversionDays("2026-10-05", "2026-10-20", "2026-10-25"), { days: 15, final: true }, "does not grow after Appointed");
});

test("date history: only the SO's hand edits are counted (automatic status dates and old Admin confirmations are not)", () => {
  assert.deepEqual(summarizeDateHistory([]), { soChanges: 0 });
  assert.deepEqual(summarizeDateHistory([{ byAdmin: false }, { byAdmin: false }]), { soChanges: 2 });
  assert.deepEqual(summarizeDateHistory([{ byAdmin: false }, { byAdmin: true }, { byAdmin: false, automatic: true }, { byAdmin: true, automatic: true }]), { soChanges: 1 });
});

console.log(`\n${passed} monthly-plan rule tests passed`);
