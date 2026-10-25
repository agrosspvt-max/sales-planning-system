/** Daily Report transaction wiring (source-level, no database): every report save / final-submission transaction goes through the bounded-limit helper; failures map to retryable messages. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_LABELS } from "@/features/labels/labels";

const service = readFileSync("src/features/daily-work/service.server.ts", "utf8");
const L = DEFAULT_LABELS as Record<string, string>;
const fnBody = (name: string) => { const i = service.indexOf(`export async function ${name}(`); assert.ok(i >= 0, name); const j = service.indexOf("\nexport async function ", i + 10); return service.slice(i, j > 0 ? j : undefined); };

for (const [name, kind] of [["enterDailyActual", "save"], ["enterTaskOutcomes", "save"], ["enterAppointmentStatus", "save"], ["enterConversionAchievability", "save"], ["enterVisitsActual", "save"], ["submitDailyReport", "final"],
  // Daily PLAN draft saves (autosave): the same bounded limits and retryable failure mapping.
  ["saveDailyWork", "save"], ["saveRelationshipVisits", "save"], ["saveDailySummary", "save"], ["saveDailyAppointment", "save"], ["saveDailyConversion", "save"]] as const) {
  const body = fnBody(name);
  assert.ok(body.includes(`dailyWorkTransaction(L, "${kind}", "${name}"`), `${name} runs through the bounded ${kind} transaction helper`);
  assert.ok(!/prisma\.\$transaction\(/.test(body), `${name} has no transaction left on Prisma's 5 s default`);
}
// The helper: explicit options, retryable mapping with Labels, no automatic retry, diagnostics without content.
const helper = service.slice(service.indexOf("async function dailyWorkTransaction"), service.indexOf("async function dailyWorkTransaction") + 1800);
assert.ok(helper.includes("prisma.$transaction((tx) => fn(tx, timer), options)"), "the limits are passed on every call");
assert.ok(helper.includes("isRetryableTransactionError(error)") && helper.includes("new ApiError(503"), "an expired transaction is a retryable 503");
assert.ok(!/for \(|while \(|retry\(/.test(helper), "the transaction is never retried automatically");
assert.ok(/console\.warn\(`\[daily-work\] op=\$\{op\}/.test(helper) && !/raw|body|answers|reason/.test(helper.slice(helper.indexOf("const report"), helper.indexOf("try {"))), "diagnostics carry the operation, phases, durations and row counts only");
assert.ok(/export const DAILY_WORK_SAVE_TRANSACTION = \{ timeout: 15_000, maxWait: 10_000 \}/.test(service) && /export const DAILY_WORK_FINAL_TRANSACTION = \{ timeout: 30_000, maxWait: 10_000 \}/.test(service), "explicit, bounded limits; execution time and connection wait are separate");
for (const key of ["daily_work.validation.report_submit_timeout", "daily_work.validation.save_timeout"]) assert.ok(L[key] && L[key]!.length > 20, `label ${key} is registered`);
// Nothing in a report transaction touches the global client (inside the callbacks every helper is handed `tx`), and the audit is written by the same transaction.
const submit = fnBody("submitDailyReport");
assert.ok(submit.includes("entityId: `REPORT:${workDate}`") && /entityId: `REPORT:\$\{workDate\}`[\s\S]{0,400}\}, tx\);/.test(submit), "the final audit record is written with the transaction client");
assert.ok(submit.includes("completeLateRequest(tx,") && submit.includes("commitTaskOutcomes(tx,"), "outcomes and the late-request completion use the transaction client");
const outcome = readFileSync("src/features/daily-work/task-outcome.server.ts", "utf8");
const commit = outcome.slice(outcome.indexOf("export async function commitTaskOutcomes"), outcome.indexOf("/* ---- commit helpers"));
assert.ok(!/\bprisma\./.test(commit) && commit.includes("tx.auditLog.createMany("), "the commit uses only the transaction client and writes its audit rows in it");
assert.ok(!/for \([^)]*\) \{[^}]*await tx\./.test(commit.replace(/for \(const \{ f \} of plan\)[\s\S]*?\n  \}\n/, "")), "no statement is issued inside a per-task loop");
// Routes declare a duration at least as long as the transaction limit on platforms that enforce one.
for (const route of ["submit-report", "actual"]) assert.ok(/export const maxDuration = (\d+)/.exec(readFileSync(`src/app/api/daily-work/${route}/route.ts`, "utf8"))!.at(1)! >= "30", `${route} route allows the transaction limit`);
console.log("report-transaction-limits.test.ts — all assertions passed");
