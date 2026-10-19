/** Daily Report deadline policy: pure boundaries and the wiring that makes every report / plan write obey it on the server. No DB. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dailyReportDeadline, isReportDeadlinePassed, isStrictDeadlinePassed, soMidnightDeadline } from "@/lib/daily-work";

const iso = (d: Date) => d.toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" });
// SO: 00:00 IST of the next day; the boundary instant is OUTSIDE the window. RM / previous rule: 12:00 noon of the next day, noon itself still inside.
assert.equal(iso(soMidnightDeadline("2026-10-19")), "2026-10-20 00:00:00");
assert.equal(iso(soMidnightDeadline("2026-12-31")), "2027-01-01 00:00:00", "month / year ends");
assert.equal(iso(dailyReportDeadline("2026-10-19")), "2026-10-20 12:00:00");
const so = soMidnightDeadline("2026-10-19"), at = (t: string) => new Date(`${t}+05:30`);
assert.equal(isStrictDeadlinePassed(so, at("2026-10-19T23:59:59")), false);
assert.equal(isStrictDeadlinePassed(so, at("2026-10-20T00:00:00")), true, "the midnight boundary itself is outside the normal window");
assert.equal(isReportDeadlinePassed("2026-10-19", at("2026-10-20T12:00:00")), false, "RM noon itself is still allowed (unchanged)");
assert.equal(isReportDeadlinePassed("2026-10-19", at("2026-10-20T12:00:01")), true);

const read = (p: string) => readFileSync(p, "utf8");
const service = read("src/features/daily-work/service.server.ts");
const fn = (name: string) => { const i = service.indexOf(`export async function ${name}(`); return service.slice(i, service.indexOf("\nexport ", i + 10)); };
// Every reporting section's report write goes through the same server-side deadline check.
for (const name of ["enterDailyActual", "enterTaskOutcomes", "enterAppointmentStatus", "recordAppointedResult", "enterConversionAchievability", "enterVisitsActual", "submitDailyReport"])
  assert.ok(fn(name).includes("assertReportWritable(tx, officerId, workDate, L)"), `${name} enforces the owner's report deadline`);
// Every plan write is blocked while an earlier report is outstanding.
for (const name of ["saveDailyWork", "saveDailyAppointment", "saveDailyConversion", "saveDailySummary", "setDailyNoPlan", "submitDailyWorkDay"])
  assert.ok(fn(name).includes("assertPlanWritable(tx, ctx, workDate, L)"), `${name} refuses a blocked Sales Officer`);
assert.ok(fn("submitDailyWorkDay").includes("recordPolicyOnFirstSubmit("), "the day's policy is fixed by its first submitted plan");
assert.ok(fn("submitDailyReport").includes("completeLateRequest(tx, officerId, workDate)"), "the approval is consumed by the successful final submission, in the same transaction");
assert.ok(!/assertReportWindowOpen|isReportDeadlinePassed\(workDate, dailyWorkClock\.now\(\)\)/.test(service), "no deadline check without the owner's policy is left");
// The client never supplies a bypass flag, and the date resolver is explicit.
for (const f of ["route.ts", "status/route.ts", "actual/route.ts", "appointed/route.ts", "submit-report/route.ts"]) assert.ok(read(`src/app/api/daily-work/${f}`).includes("resolveReportDateForOwner("), `${f} resolves the report date for the owner`);
assert.ok(!/ignoreDeadline|skipDeadline|overrideDeadline|forceLate/i.test(service + read("src/features/daily-work/report-policy.server.ts")), "no client-supplied 'ignore the deadline' flag exists");
// Requests: atomic decision + durable constraints.
const policy = read("src/features/daily-work/report-policy.server.ts");
assert.ok(policy.includes(`WHERE "id" = \${id} AND "status" = 'PENDING'`), "the decision is one conditional update: a stale second decision matches nothing");
const mig = read("prisma/migrations/20261024000000_daily_report_deadline_policy/migration.sql");
assert.ok(mig.includes('"LateReportRequest_one_open_key"') && mig.includes(`WHERE "status" IN ('PENDING', 'APPROVED')`), "one open request per officer and report date (database-enforced)");
assert.ok(mig.includes('"DailyReportPolicy_officer_date_key"') && mig.includes("INSERT INTO \"DailyReportRollout\""), "persisted policy per reporting day + a persisted rollout cutoff");
// Performance reads are batched (no per-row queries) and Requests are fetched only when opened.
const perf = fn("getDailyPerformance");
assert.ok(perf.includes("loadPolicyDeadlines(prisma, ids, from, to)") && perf.includes("loadLateRequestFacts(prisma, ids, from, to)"), "policy + late facts are loaded once for the whole table");
const page = read("src/features/daily-work/performance-page.tsx");
assert.ok(page.includes("requestsOpened && canReviewRequests"), "Requests are mounted (and fetched) only after the view is opened, and only for reviewers");
assert.ok(page.includes('active={mode === "requests"}'), "leaving Requests disables its query even though its filter state stays mounted");
console.log("report-policy.test.ts — all assertions passed");
