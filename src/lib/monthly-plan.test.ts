/** Pure Monthly Planning rules: the ROW status workflow, payload validation, month / plan-date checks. */
import assert from "node:assert/strict";
import { EMPTY_SENT_FORM, chooseSentAnswer, sentFormAnswered, sentFormBody, setSentNotSent, parseSentInfo, isLegacySentInfo, isMonthlyWorkflowOpen, appointmentMonthlyTotals, conversionDays, daysBetween, displayRowStatus, summarizeDateHistory, monthlySheetStatus, ROW_STATUSES, ROW_STATUS_LABEL, TRANSITIONS, adminActionFor, parseDocInfo, parseTransition, transitionActor, validatePartyName, validatePlanDate } from "./monthly-plan";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

test("one row-level lifecycle: forward moves only, Appointed and Rejected are terminal, labels are consistent", () => {
  assert.deepEqual([...ROW_STATUSES], ["NONE", "DOC_NOT_SENT", "DOC_SENT", "DOC_RECEIVED", "SD_BOUNCE", "APPOINTED", "REJECTED"]);
  const rank = Object.fromEntries(ROW_STATUSES.map((s, i) => [s, s === "REJECTED" ? 99 : i]));
  for (const from of ROW_STATUSES) for (const t of TRANSITIONS[from]) assert.ok(rank[t.to]! > rank[from]!, `${from} → ${t.to} must move forward`);
  assert.deepEqual(TRANSITIONS.APPOINTED, []); assert.deepEqual(TRANSITIONS.REJECTED, []);
  assert.deepEqual(Object.values(ROW_STATUS_LABEL), ["Pending", "Document Not Sent", "Doc Send By SO", "Doc Received", "SD Bounce", "Appointed", "Rejected"]);
});

test("the owner's steps are None → Doc Send By SO / Document Not Sent and Document Not Sent → Doc Send By SO; every other move is an Admin step", () => {
  const ownerSteps = new Set(["NONE>DOC_SENT", "NONE>DOC_NOT_SENT", "DOC_NOT_SENT>DOC_SENT"]);
  assert.equal(transitionActor("NONE", "DOC_SENT"), "OWNER"); assert.equal(transitionActor("NONE", "DOC_NOT_SENT"), "OWNER"); assert.equal(transitionActor("DOC_NOT_SENT", "DOC_SENT"), "OWNER");
  for (const from of ROW_STATUSES) for (const t of TRANSITIONS[from]) assert.equal(t.actor, ownerSteps.has(`${from}>${t.to}`) ? "OWNER" : "ADMIN", `${from} → ${t.to}`);
  assert.equal(transitionActor("DOC_NOT_SENT", "REJECTED"), "ADMIN");
  assert.equal(transitionActor("DOC_SENT", "DOC_RECEIVED"), "ADMIN");
  assert.equal(transitionActor("DOC_RECEIVED", "SD_BOUNCE"), "ADMIN");
  assert.equal(transitionActor("DOC_RECEIVED", "APPOINTED"), "ADMIN");
  assert.equal(transitionActor("NONE", "REJECTED"), "ADMIN");
});

test("invalid moves do not exist (no skipping the document steps, no going back, nothing out of a terminal status)", () => {
  for (const [from, to] of [["NONE", "DOC_RECEIVED"], ["NONE", "APPOINTED"], ["NONE", "SD_BOUNCE"], ["DOC_SENT", "APPOINTED"], ["DOC_SENT", "SD_BOUNCE"], ["DOC_RECEIVED", "DOC_SENT"], ["DOC_RECEIVED", "NONE"],
    ["SD_BOUNCE", "DOC_RECEIVED"], ["APPOINTED", "REJECTED"], ["APPOINTED", "NONE"], ["REJECTED", "NONE"], ["REJECTED", "DOC_SENT"], ["NONE", "NONE"], ["X", "DOC_SENT"], ["DOC_SENT", "PART_REJECTED"],
    // Document Not Sent can never skip the Admin steps or go backwards.
    ["DOC_NOT_SENT", "DOC_RECEIVED"], ["DOC_NOT_SENT", "SD_BOUNCE"], ["DOC_NOT_SENT", "APPOINTED"], ["DOC_NOT_SENT", "NONE"], ["DOC_NOT_SENT", "DOC_NOT_SENT"], ["DOC_SENT", "DOC_NOT_SENT"], ["DOC_RECEIVED", "DOC_NOT_SENT"]]) assert.equal(transitionActor(from!, to!), null, `${from} → ${to}`);
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

test("sent form answers: Document and Cheque are each Complete or Incomplete (independent, no defaults); both Incomplete is valid; the special option takes no answers", () => {
  const ok = (raw: unknown) => { const r = parseSentInfo(raw); assert.equal(r.ok, true, JSON.stringify(raw)); return (r as { ok: true; value: unknown }).value; };
  assert.deepEqual(ok({ documentStatus: "COMPLETE", chequeStatus: "INCOMPLETE" }), { documentStatus: "COMPLETE", chequeStatus: "INCOMPLETE", documentNotSent: false, other: null });
  assert.deepEqual(ok({ documentStatus: "INCOMPLETE", chequeStatus: "INCOMPLETE", other: "  cheque   missing " }), { documentStatus: "INCOMPLETE", chequeStatus: "INCOMPLETE", documentNotSent: false, other: "cheque missing" }, "both Incomplete is an explicit, valid answer — not Document Not Sent");
  assert.deepEqual(ok({ documentNotSent: true, other: "will courier" }), { documentStatus: null, chequeStatus: null, documentNotSent: true, other: "will courier" });
  assert.deepEqual(ok({ documentNotSent: true }), { documentStatus: null, chequeStatus: null, documentNotSent: true, other: null }, "Other stays optional");
  for (const bad of [{}, null, undefined, { documentStatus: "COMPLETE" }, { chequeStatus: "COMPLETE" }, { documentStatus: "COMPLETE", chequeStatus: "" }, { documentStatus: "YES", chequeStatus: "COMPLETE" },
    { documents: true, checks: true }, { documentNotSent: true, documentStatus: "COMPLETE" }, { documentNotSent: true, chequeStatus: "INCOMPLETE" }, { documentStatus: "COMPLETE", chequeStatus: "COMPLETE", other: "x".repeat(501) }, { documentNotSent: "true" }])
    assert.equal(parseSentInfo(bad).ok, false, JSON.stringify(bad));
  assert.equal(isLegacySentInfo({ documents: true, checks: false, other: null }), true, "old booleans are legacy (completeness unrecorded)");
  assert.equal(isLegacySentInfo({ documentStatus: "COMPLETE", chequeStatus: "COMPLETE", documentNotSent: false, other: null }), false);
  assert.equal(isLegacySentInfo({ documentNotSent: true, documentStatus: null, chequeStatus: null, other: null }), false);
});

test("form state: one choice per item (selecting clears the other), nothing preselected, the special option clears + locks, unticking restores nothing", () => {
  let f = EMPTY_SENT_FORM;
  assert.deepEqual([f.documentStatus, f.chequeStatus, f.notSent, sentFormAnswered(f)], [null, null, false, false], "a new action has no preselection");
  f = chooseSentAnswer(f, "documentStatus", "COMPLETE", true); assert.equal(f.documentStatus, "COMPLETE");
  f = chooseSentAnswer(f, "documentStatus", "INCOMPLETE", true); assert.equal(f.documentStatus, "INCOMPLETE", "selecting Incomplete replaces Complete (mutually exclusive)");
  f = chooseSentAnswer(f, "documentStatus", "INCOMPLETE", false); assert.equal(f.documentStatus, null, "unticking leaves it unanswered");
  f = chooseSentAnswer(f, "documentStatus", "INCOMPLETE", true); assert.equal(sentFormAnswered(f), false, "Cheque is still unanswered");
  f = chooseSentAnswer(f, "chequeStatus", "INCOMPLETE", true); assert.equal(sentFormAnswered(f), true, "both Incomplete is answered");
  assert.deepEqual(sentFormBody({ ...f, other: "x" }), { documentNotSent: false, documentStatus: "INCOMPLETE", chequeStatus: "INCOMPLETE", other: "x" });
  const special = setSentNotSent({ ...f, other: "keep me" }, true);
  assert.deepEqual([special.documentStatus, special.chequeStatus, special.notSent, special.other, sentFormAnswered(special)], [null, null, true, "keep me", true], "checking clears the four answers, keeps Other Details, allows continuing");
  assert.deepEqual(chooseSentAnswer(special, "documentStatus", "COMPLETE", true), special, "the four boxes are locked while it is checked");
  assert.deepEqual(sentFormBody({ ...special, documentStatus: "COMPLETE" }), { documentNotSent: true, documentStatus: null, chequeStatus: null, other: "keep me" }, "the special option never sends answers");
  const back = setSentNotSent(special, false);
  assert.deepEqual([back.documentStatus, back.chequeStatus, back.notSent, sentFormAnswered(back)], [null, null, false, false], "unchecking re-enables the boxes, unanswered — previous choices are not restored");
});

test("the owner's form posts Doc Send By SO; the special answer resolves to Document Not Sent (one form, one validation)", () => {
  const sent = parseTransition({ to: "DOC_SENT", sent: { documentStatus: "COMPLETE", chequeStatus: "COMPLETE" } });
  assert.deepEqual(sent, { ok: true, value: { to: "DOC_SENT", sent: { documentStatus: "COMPLETE", chequeStatus: "COMPLETE", documentNotSent: false, other: null } } });
  const notSent = parseTransition({ to: "DOC_SENT", sent: { documentNotSent: true } });
  assert.deepEqual(notSent, { ok: true, value: { to: "DOC_NOT_SENT", sent: { documentStatus: null, chequeStatus: null, documentNotSent: true, other: null } } });
  assert.equal(parseTransition({ to: "DOC_NOT_SENT" }).ok, true, "a direct Document Not Sent request is the same special answer");
  assert.equal(parseTransition({ to: "DOC_NOT_SENT", sent: { documentStatus: "COMPLETE", chequeStatus: "COMPLETE" } }).ok, true);
  assert.equal((parseTransition({ to: "DOC_NOT_SENT", sent: { documentStatus: "COMPLETE", chequeStatus: "COMPLETE" } }) as { value: { sent: { documentStatus: unknown } } }).value.sent.documentStatus, null, "…and never keeps answers");
  assert.equal(parseTransition({ to: "DOC_SENT", sent: { documents: true, checks: true } }).ok, false, "the old checkbox payload is refused");
});

test("Document Not Sent stays pending: it is an open monthly status for the Pending count", () => {
  assert.equal(isMonthlyWorkflowOpen("DOC_NOT_SENT"), true); assert.equal(isMonthlyWorkflowOpen("NONE"), true); assert.equal(isMonthlyWorkflowOpen("DOC_SENT"), true);
  assert.equal(isMonthlyWorkflowOpen("APPOINTED"), false); assert.equal(isMonthlyWorkflowOpen("REJECTED"), false);
  assert.deepEqual(appointmentMonthlyTotals([{ marketId: "a", opStatus: "DOC_NOT_SENT" }, { marketId: "b", opStatus: "APPOINTED" }, { marketId: "c", opStatus: "NONE" }]), { monthlyDealerPlan: 3, pending: 2 });
  assert.equal(monthlySheetStatus([{ opStatus: "DOC_NOT_SENT" }, { opStatus: "APPOINTED" }]), "In Progress", "a sheet with a Document Not Sent row is not Completed");
});

test("transition payloads: Doc Received needs Document or Check; Doc Send needs the Complete / Incomplete answers; SD Bounce, Appointed, Rejected take optional remarks; the browser cannot pick None", () => {
  assert.equal(parseTransition({ to: "DOC_SENT", sent: { documentStatus: "INCOMPLETE", chequeStatus: "INCOMPLETE" } }).ok, true);
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
  assert.equal(displayRowStatus("NONE", "APPROVED"), "Pending", "an approved entry whose appointment workflow has not started is operationally Pending");
  assert.equal(displayRowStatus("DOC_NOT_SENT", "APPROVED"), "Document Not Sent");
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
