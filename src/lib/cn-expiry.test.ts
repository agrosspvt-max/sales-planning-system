import assert from "node:assert/strict";
import {
  CN_DEFAULT_GRACE_DAYS, addCnDays, cnExpiryDateProblem, cnTaskWindowEnd, dueCnTransitions, effectiveCnStage, isCnTaskDateAllowed, isCnNearExpiry, parseCnGraceDays,
} from "./cn-expiry";
import { cnRequestExpiryDateKey, cnAcceptanceNeedsExpiry, validateCnAcceptance } from "./cn-request";
import { buildCnTimeline } from "./cn-timeline";

const ist = (date: string, time = "00:00:00") => new Date(`${date}T${time}+05:30`);
const state = (expiry: string, grace: number, stage: string | null = "WORKING") => ({ cnExpiryDate: expiry, cnGraceDays: grace, cnPolicyStage: stage });

// ---- grace period field: default 5, positive whole numbers only
assert.equal(CN_DEFAULT_GRACE_DAYS, 5);
for (const ok of [1, 5, "5", " 7 ", 365]) assert.ok(parseCnGraceDays(ok) != null, `${ok} accepted`);
for (const bad of [0, -1, 2.5, "2.5", "abc", "", null, undefined, true, 366, "1e2", "+3", Number.NaN, Infinity]) assert.equal(parseCnGraceDays(bad), null, `${String(bad)} rejected`);

// ---- expiry date: real YYYY-MM-DD, not in the past; today is allowed (valid through the end of the day)
assert.equal(cnExpiryDateProblem("2026-10-25", "2026-10-22"), null);
assert.equal(cnExpiryDateProblem("2026-10-22", "2026-10-22"), null, "today is still valid");
assert.equal(cnExpiryDateProblem("2026-10-21", "2026-10-22"), "past");
for (const bad of ["25/10/2026", "2026-2-3", "2026-02-30", "2027-02-29", "", null, 20261025, "2026-10-25T00:00:00Z"]) assert.equal(cnExpiryDateProblem(bad, "2026-10-22"), "invalid", String(bad));
assert.equal(cnExpiryDateProblem("2028-02-29", "2026-10-22"), null, "leap day");

// ---- effective deadline: no automatic grace; manually granted days are already in the date.
const ex = state("2026-10-25", 0);
assert.deepEqual(dueCnTransitions(ex, true, ist("2026-10-25", "23:59:59")), []);
assert.equal(effectiveCnStage(ex, true, ist("2026-10-26")), "EXPIRED");
assert.equal(effectiveCnStage(ex, true, new Date("2026-10-25T18:29:59Z")), "WORKING");
assert.equal(effectiveCnStage(ex, true, new Date("2026-10-25T18:30:00Z")), "EXPIRED");
const extended = state(addCnDays("2026-10-25", 5), 5, "GRACE");
assert.equal(extended.cnExpiryDate, "2026-10-30");
assert.equal(effectiveCnStage(extended, true, ist("2026-10-30", "23:59:59")), "GRACE");
assert.equal(effectiveCnStage(extended, true, ist("2026-10-31")), "EXPIRED", "never add grace twice");
const late = dueCnTransitions(extended, true, ist("2027-03-01"));
assert.deepEqual(late.map(x => x.kind), ["EXPIRED"]);
assert.equal(late[0]!.effectiveAt.toISOString(), ist("2026-10-31").toISOString());
assert.deepEqual(dueCnTransitions(ex, false, ist("2027-01-01")), [], "Paid response awaiting verification is preserved");
assert.equal(effectiveCnStage(state("2026-10-25", 0, null), true, ist("2027-01-01")), null);
for (const [start, end] of [["2026-10-28", "2026-11-02"], ["2026-12-29", "2027-01-03"], ["2028-02-27", "2028-03-03"]]) assert.equal(addCnDays(start!, 5), end);
assert.equal(addCnDays("2026-08-10", 5), "2026-08-15", "user example");
const today = "2026-10-22";
assert.equal(isCnNearExpiry(state("2026-10-26", 0), today), true, "four days before");
assert.equal(isCnNearExpiry(state("2026-10-27", 0), today), false, "five days before");
assert.equal(isCnNearExpiry(state(today, 0), today), true, "expiry date inclusive");
assert.equal(isCnNearExpiry(state("2026-10-21", 0), today), false);
assert.equal(isCnNearExpiry(state("2026-12-31", 5, "GRACE"), today), true, "all grace-granted CNs remain here");
assert.equal(isCnNearExpiry(state(today, 5, "EXPIRED"), today), false);
assert.equal(cnTaskWindowEnd(extended, today), "2026-10-30");
assert.equal(cnTaskWindowEnd(state("2026-10-30", 5, "EXPIRED"), today), null);
const accepted = ist("2026-10-20", "10:00:00");
assert.equal(isCnTaskDateAllowed("2026-10-29", accepted, extended, today), true);
assert.equal(isCnTaskDateAllowed("2026-10-31", accepted, extended, today), false);
assert.equal(isCnTaskDateAllowed("2026-10-25", accepted, extended, today), false, "Sunday remains unavailable");
assert.equal(isCnTaskDateAllowed("2026-10-19", accepted, extended, today), false);
assert.equal(isCnTaskDateAllowed("2026-10-29", accepted, extended, "2026-10-31"), false);

// ---- historical conversion keeps the EXACT old deadline: acceptance date = Day 1 ⇒ expiry = acceptance date + days − 1 (also across midnight UTC vs IST)
assert.equal(cnRequestExpiryDateKey("2026-10-20T10:00:00+05:30", 3), "2026-10-22");
assert.equal(cnRequestExpiryDateKey("2026-10-20T00:10:00+05:30", 1), "2026-10-20", "1 day = the acceptance day only");
assert.equal(cnRequestExpiryDateKey("2026-10-19T19:00:00Z", 2), "2026-10-21", "19:00Z on 19/10 is already 20/10 in IST");

// ---- acceptance validation shared by the form: expiry + grace for Payment Pending and direct Posted in Ledger; "Other" exempt
const base = { acceptanceReasonDetails: "", postedAmount: "", outstandingAmount: "100", hasFile: true, todayKey: today };
assert.equal(cnAcceptanceNeedsExpiry("ACCEPTED_NOT_POSTED", "PAYMENT_PENDING"), true);
assert.equal(cnAcceptanceNeedsExpiry("POSTED_IN_LEDGER", ""), false);
assert.equal(cnAcceptanceNeedsExpiry("ACCEPTED_NOT_POSTED", "OTHER"), false);
const v = (over: Record<string, unknown>) => validateCnAcceptance({ status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING", expiryDate: "2026-10-25", graceDays: "5", ...base, ...over } as never);
assert.equal(v({}), null);
assert.match(v({ expiryDate: "" })!, /required/i);
assert.match(v({ expiryDate: "2026-10-21" })!, /past|valid/i);
assert.match(v({ expiryDate: "2026-02-30" })!, /valid/i);
assert.equal(v({ graceDays: undefined }), null, "acceptance has no grace field");
assert.equal(v({ status: "ACCEPTED_NOT_POSTED", reason: "OTHER", acceptanceReasonDetails: "why", expiryDate: "", graceDays: "" }), null, "Other is not governed by the expiry policy");
assert.equal(v({ status: "POSTED_IN_LEDGER", reason: "", postedAmount: "100" }), null);
assert.equal(v({ status: "POSTED_IN_LEDGER", reason: "", postedAmount: "100", expiryDate: "", graceDays: "" }), null, "direct posting does not ask for expiry/grace");

// ---- timeline: expiry events keep their effective time, system vs account actors, cycles and reopen details
const tl = buildCnTimeline({
  status: "ACCEPTED_NOT_POSTED", createdAt: ist("2026-10-20", "09:00:00"), acceptedAt: ist("2026-10-20", "10:00:00"), cnWorkingUploadedAt: ist("2026-10-20", "10:00:00"), cnWorkingFileName: "w.pdf", acceptanceReason: "PAYMENT_PENDING",
  expiryEvents: [
    { id: "e3", kind: "EXPIRED", cycleNo: 1, effectiveAt: ist("2026-10-31"), processedAt: ist("2027-01-05", "09:00:00"), expiryDate: "2026-10-25", graceDays: 5 },
    { id: "e1", kind: "POLICY_SET", cycleNo: 1, effectiveAt: ist("2026-10-20", "10:00:00"), actor: "Admin (@admin)", expiryDate: "2026-10-25", graceDays: 5 },
    { id: "e2", kind: "ENTERED_GRACE", cycleNo: 1, effectiveAt: ist("2026-10-26"), processedAt: ist("2027-01-05", "09:00:00"), expiryDate: "2026-10-25", graceDays: 5 },
    { id: "e4", kind: "REOPENED", cycleNo: 2, effectiveAt: ist("2027-01-05", "10:00:00"), actor: "Accounts (@acc)", expiryDate: "2027-01-20", previousExpiryDate: "2026-10-25", graceDays: 5, reason: "Dealer promised payment", authorizedBy: "Regional Head" },
  ],
});
assert.deepEqual(tl.map((e) => e.kind), ["SUBMITTED", "WORKING_SHARED", "EXPIRY_SET", "ENTERED_GRACE", "EXPIRED", "REOPENED"], "chronological, settings right after Working Shared");
assert.equal(tl.find((e) => e.kind === "ENTERED_GRACE")!.occurredAt, ist("2026-10-26").toISOString(), "effective time, not the later processing time");
assert.equal(tl.find((e) => e.kind === "ENTERED_GRACE")!.processedAt, ist("2027-01-05", "09:00:00").toISOString());
assert.equal(tl.find((e) => e.kind === "EXPIRED")!.system, true, "automatic transitions are System actions");
assert.equal(tl.find((e) => e.kind === "EXPIRED")!.daysFromSubmission, 11, "calendar days from the original submission (Day 0)");
const reopened = tl.find((e) => e.kind === "REOPENED")!;
assert.equal(reopened.actor, "Accounts");
assert.equal(reopened.system, undefined);
assert.equal(reopened.authorizedBy, "Regional Head", "the authorizing person is separate from the acting account");
assert.equal(reopened.previousExpiryDate, "2026-10-25");
assert.equal(reopened.expiryDate, "2027-01-20");
assert.equal(reopened.graceEndDate, "2027-01-25");
assert.equal(reopened.cycleNo, 2);
// direct Posted in Ledger: settings are shown for reference, but no invented Working Shared step
const direct = buildCnTimeline({ status: "POSTED_IN_LEDGER", createdAt: ist("2026-10-20", "09:00:00"), acceptedAt: ist("2026-10-20", "10:00:00"), postedAt: ist("2026-10-20", "10:00:00"), cnWorkingFileName: "w.pdf",
  expiryEvents: [{ id: "p1", kind: "POLICY_SET", cycleNo: 1, effectiveAt: ist("2026-10-20", "10:00:00"), actor: "Admin", expiryDate: "2026-10-25", graceDays: 5 }] });
assert.deepEqual(direct.map((e) => e.kind), ["SUBMITTED", "EXPIRY_SET", "POSTED_IN_LEDGER"]);

console.log("cn-expiry rule tests passed");

const grantTimeline = buildCnTimeline({ status: "ACCEPTED_NOT_POSTED", createdAt: ist("2026-08-01"), expiryEvents: [
  { id: "g", kind: "GRACE_GRANTED", cycleNo: 1, effectiveAt: ist("2026-08-08"), actor: "Accounts (@accounts)", expiryDate: "2026-08-15", previousExpiryDate: "2026-08-10", graceDays: 5, expiryIncludesGrace: true },
] });
const grant = grantTimeline.find(e => e.kind === "GRACE_GRANTED")!;
assert.equal(grant.daysFromSubmission, 7);
assert.equal(grant.graceEndDate, null, "effective expiry isn't extended again in the timeline");
assert.equal(grant.previousExpiryDate, "2026-08-10");
