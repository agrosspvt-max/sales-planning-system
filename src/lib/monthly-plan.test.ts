/** Pure Monthly Planning rules: the option lifecycle table, payload validation, month / plan-date checks. */
import assert from "node:assert/strict";
import { monthlySheetStatus, OPTION_STATUSES, TRANSITIONS, adminActionFor, parseDocInfo, parseTransition, transitionActor, validatePartyName, validatePlanDate } from "./monthly-plan";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

test("the lifecycle table defines every status and only forward moves", () => {
  assert.deepEqual([...OPTION_STATUSES], ["PENDING", "DOC_SENT", "DOC_RECEIVED", "SD_DELAYED_BY_SO", "SD_BOUNCE", "APPOINTED", "PART_REJECTED"]);
  const rank = Object.fromEntries(OPTION_STATUSES.map((s, i) => [s, s === "PART_REJECTED" ? 99 : i]));
  for (const from of OPTION_STATUSES) for (const t of TRANSITIONS[from]) assert.ok(rank[t.to]! > rank[from]!, `${from} → ${t.to} must move forward`);
  assert.deepEqual(TRANSITIONS.APPOINTED, [], "Appointed is terminal");
  assert.deepEqual(TRANSITIONS.PART_REJECTED, [], "Part Rejected is terminal");
});

test("only Pending → Doc Sent is an owner step; every other move is an Admin step", () => {
  assert.equal(transitionActor("PENDING", "DOC_SENT"), "OWNER");
  for (const from of OPTION_STATUSES) for (const t of TRANSITIONS[from]) if (!(from === "PENDING" && t.to === "DOC_SENT")) assert.equal(t.actor, "ADMIN", `${from} → ${t.to}`);
  assert.equal(transitionActor("DOC_SENT", "DOC_RECEIVED"), "ADMIN");
  assert.equal(transitionActor("DOC_RECEIVED", "APPOINTED"), "ADMIN");
});

test("invalid moves do not exist (no skipping the document steps, no going back, nothing out of a terminal status)", () => {
  for (const [from, to] of [["PENDING", "DOC_RECEIVED"], ["PENDING", "APPOINTED"], ["PENDING", "SD_BOUNCE"], ["DOC_SENT", "APPOINTED"], ["DOC_SENT", "SD_BOUNCE"], ["DOC_RECEIVED", "DOC_SENT"], ["DOC_RECEIVED", "PENDING"],
    ["SD_BOUNCE", "SD_DELAYED_BY_SO"], ["SD_BOUNCE", "DOC_RECEIVED"], ["APPOINTED", "PART_REJECTED"], ["APPOINTED", "PENDING"], ["PART_REJECTED", "PENDING"], ["PART_REJECTED", "DOC_SENT"], ["PENDING", "PENDING"], ["X", "DOC_SENT"]]) assert.equal(transitionActor(from!, to!), null, `${from} → ${to}`);
  assert.equal(transitionActor("DOC_RECEIVED", "SD_DELAYED_BY_SO"), "ADMIN");
  assert.equal(transitionActor("DOC_RECEIVED", "SD_BOUNCE"), "ADMIN", "later SD states may be skipped forward");
});

test("Admin permission: rejection → reject, every other Admin step → approve", () => {
  assert.equal(adminActionFor("PART_REJECTED"), "reject");
  for (const s of ["DOC_RECEIVED", "SD_DELAYED_BY_SO", "SD_BOUNCE", "APPOINTED"] as const) assert.equal(adminActionFor(s), "approve");
});

test("sent / received details: at least one item; Other needs its clarification; stored as given", () => {
  assert.deepEqual(parseDocInfo({ documents: true, checks: false, other: false }), { ok: true, value: { documents: true, checks: false, other: false, otherDetails: null } });
  assert.deepEqual(parseDocInfo({ documents: true, other: true, otherDetails: "  GST   certificate " }), { ok: true, value: { documents: true, checks: false, other: true, otherDetails: "GST certificate" } });
  for (const bad of [{}, null, undefined, { documents: "yes" }, { documents: false, checks: false, other: false }, { other: true }, { other: true, otherDetails: "  " }, { other: true, otherDetails: "x".repeat(501) }]) assert.equal(parseDocInfo(bad).ok, false, JSON.stringify(bad));
  assert.deepEqual(parseDocInfo({ other: false, otherDetails: "ignored" }).ok, false);
});

test("transition payloads: Doc Sent / Received need details, Appointed an actual party, SD + rejection a reason; the browser cannot pick Pending", () => {
  assert.equal(parseTransition({ to: "DOC_SENT", sent: { checks: true } }).ok, true);
  assert.equal(parseTransition({ to: "DOC_SENT" }).ok, false, "Doc Sent without details is refused");
  assert.equal(parseTransition({ to: "DOC_RECEIVED", received: { documents: true } }).ok, true);
  assert.equal(parseTransition({ to: "DOC_RECEIVED", sent: { documents: true } }).ok, false, "received details are not the sent details");
  for (const to of ["SD_DELAYED_BY_SO", "SD_BOUNCE", "PART_REJECTED"]) { assert.equal(parseTransition({ to }).ok, false, to); assert.equal(parseTransition({ to, reason: "  " }).ok, false, to); assert.equal(parseTransition({ to, reason: "Cheque returned" }).ok, true, to); }
  assert.equal(parseTransition({ to: "APPOINTED" }).ok, false);
  assert.deepEqual(parseTransition({ to: "APPOINTED", actualPartyName: " ABC  Traders ", appointedOn: "1999-01-01", actorId: "x" }), { ok: true, value: { to: "APPOINTED", actualPartyName: "ABC Traders" } }, "extra fields (date, actor) are dropped");
  for (const to of ["PENDING", "NOPE", undefined, null, 3]) assert.equal(parseTransition({ to }).ok, false, String(to));
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

test("a Monthly Plan's list status is derived from its options", () => {
  const row = (...statuses: string[]) => ({ options: statuses.map((status) => ({ status })) });
  assert.equal(monthlySheetStatus([]), "Draft", "a freshly created plan has no markets yet");
  assert.equal(monthlySheetStatus([row("PENDING", "PENDING")]), "In Progress");
  assert.equal(monthlySheetStatus([row("APPOINTED", "PENDING")]), "In Progress", "one option still open");
  assert.equal(monthlySheetStatus([row("APPOINTED", "PART_REJECTED"), row("PART_REJECTED", "PART_REJECTED")]), "Completed");
  assert.equal(monthlySheetStatus([row("APPOINTED", "PART_REJECTED"), row("DOC_SENT", "PENDING")]), "In Progress");
});

console.log(`\n${passed} monthly-plan rule tests passed`);
