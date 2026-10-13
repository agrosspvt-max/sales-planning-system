/** Billing Exception tasks in Daily Work: the rendered panel and the wiring that keeps this source separate from CN / Calendar. DB behaviour: billing-task.integration.ts (opt-in). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { testLoader } from "@/features/dealer-tags/test-loader";

const load = testLoader({
  "@tanstack/react-query": { useMutation: () => ({ isPending: false, mutate() {} }), useQuery: () => ({ data: undefined, isLoading: true, error: null }), useQueryClient: () => ({ invalidateQueries() {} }) },
  "@/lib/api-client": { api: { post: async () => ({}), get: async () => ({}) } },
  "@/features/labels/label-ui": { useLabel: (key: string) => (DEFAULT_LABELS as Record<string, string>)[key] ?? key },
});
const { BillingTaskPanel } = load<typeof import("./billing-task-ui")>("src/features/daily-work/billing-task-ui.tsx");
const T = (over: Record<string, unknown> = {}) => ({ taskId: "t1", billingExceptionId: "e1", dealerId: "d1", dealerName: "Beta Stores", taskType: "BILLING_EXCEPTION", planType: "RECOVERY", amount: 20000, promisedDate: "2026-10-09", taskDate: "2026-10-09", rescheduled: false, confirmed: false, overdue: false, billNo: "B-1", authPerson: "Varun sir", ...over });
const html = (tasks: unknown[], locked = false) => renderToStaticMarkup(<BillingTaskPanel tasks={tasks as never} locked={locked} onChanged={() => {}} />);
const text = (h: string) => h.replace(/<[^>]*>/g, "|").replace(/\|+/g, "|");

// display: dealer, amount, Task Type, Plan Type, scheduled payment date, actions
let out = html([T()]);
for (const needle of ["Beta Stores", "₹20,000", "Billing Exception", "Recovery", "09/10/2026", ">Confirm<", ">Details<", ">Reschedule<", "Billing Exception tasks"]) assert.ok(out.includes(needle), needle);
assert.ok(!out.includes("Overdue") && !out.includes("Confirmed"), "an on-time unconfirmed task");
// overdue keeps the ORIGINAL promised date and says so; a rescheduled task shows both dates; confirmed replaces the Confirm button
out = html([T({ overdue: true, taskDate: "2026-10-09", promisedDate: "2026-10-07" })]);
assert.ok(out.includes("Overdue") && out.includes("07/10/2026"), "overdue is labelled; the promised date is shown");
out = html([T({ rescheduled: true, taskDate: "2026-10-12" })]);
assert.ok(out.includes("Rescheduled: 12/10/2026") && out.includes("09/10/2026"));
out = html([T({ confirmed: true })]);
assert.ok(out.includes("Confirmed") && !out.includes(">Confirm<"), "confirmed tasks no longer offer Confirm");
out = html([T()], true);
assert.ok(/<button[^>]*disabled[^>]*>Confirm<\/button>/.test(out) && /<button[^>]*disabled[^>]*>Reschedule<\/button>/.test(out), "a locked (submitted) day disables the actions");
out = html([T({ taskId: "t1" }), T({ taskId: "t2", amount: 2500, dealerName: "Beta Stores" })]);
assert.equal((out.match(/data-billing-task-id/g) ?? []).length, 2, "several tasks for one dealer stay independent rows");

/* ---- wiring ---- */
const read = (p: string) => readFileSync(p, "utf8");
const ui = read("src/features/daily-work/billing-task-ui.tsx"), server = read("src/features/daily-work/billing-task.server.ts");
assert.ok(!/cn-requests|CnPaymentEvent|CnRequest/.test(ui + server.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "no CN endpoint, table or id is used by the Billing Exception source");
assert.ok(ui.includes("/api/billing-exception-tasks/${id}/confirm") && ui.includes("/api/billing-exception-tasks/${task.taskId}/reschedule") && ui.includes("/api/billing-exception-tasks/${id}"), "its own endpoints");
const page = read("src/features/daily-work/daily-work-page.tsx");
const panelUse = page.slice(page.indexOf("<BillingTaskPanel") - 220, page.indexOf("<BillingTaskPanel") + 120);
assert.ok(panelUse.includes("billingTasks") && !panelUse.includes("autoTasksEnabled"), "the panel does not depend on the Auto Tasks container's visibility setting");
assert.ok(page.includes("taskTypeBilling") && page.includes("billingDealerIds"), "Task Type label");
const service = read("src/features/daily-work/service.server.ts");
assert.ok(service.includes("${BILLING_CONTRIBUTION_UNION}") && service.includes("countUnconfirmedBillingTasks(tx, officerId, workDate, day.currentBatchId)") && service.includes("billingTasks,") && service.includes("billingEntryIds,"), "Today's Plan floor, submit gate and payload include the source");
const auto = read("src/features/daily-work/auto-task-materialization.server.ts");
assert.ok(auto.includes("materializeDueBillingTasksInTransaction(tx, officerId, workDate, day)") && auto.includes("cn.materializedTasks + billing.materialized"), "one materialization entry point for every read path and submit gate, counts combined (a newly added task blocks finalization like a CN task)");
assert.ok(/SELECT "id" FROM "BillingExceptionTask" WHERE "id" = \$\{id\} FOR UPDATE/.test(server) && server.indexOf("lockDailyWorkDay(tx, ctx.userId, workDate)") < server.indexOf("loadLocked(tx, id)"), "lock order: Daily Work day, then the task row");
assert.ok(/UPDATE "BillingExceptionTask"[\s\S]{0,400}WHERE "id" = \$\{task\.id\} AND "dailyWorkEntryId" IS NULL/.test(server), "claim-first idempotent link");
assert.ok(!/DealerPaymentReceipt|LastPaymentReceipt|todaysActual|paymentMode/i.test(server.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "a task never writes receipts, actuals or payment mode");
const perms = read("src/features/accounts/route-permissions.ts");
assert.ok(perms.includes('p.startsWith("billing-exception-tasks")) return read ? ["lastPaymentReport", "read"] : null'), "no administrative write on tasks");
/* ---- Calendar visibility: a read-only view of the SAME task row ---- */
const vis = read("src/features/daily-work/billing-task-visibility.server.ts"), cal = read("src/features/calendar/calendar.server.ts"), calUi = read("src/features/calendar/calendar-view.tsx");
const visCode = vis.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
assert.ok(!/\.(create|update|updateMany|upsert|delete)\(|\$executeRaw|prisma\.(calendarEntry|dailyWorkEntry)\b/.test(visCode), "Calendar visibility only reads: it creates no task, Calendar entry or Daily Work row");
assert.ok(cal.includes("loadCalendarBillingTasks(ctx, gte, lt, ownerIds)") && (cal.match(/loadCalendarBillingTasks\(ctx, gte, lt, ownerIds\)/g) ?? []).length === 2, "month and upcoming reuse the Calendar's own resolved owner scope");
assert.ok(calUi.includes("BillingTaskDetailDialog") && calUi.includes("calendar-billing-task") && calUi.includes("billingByDate"), "Calendar shows the task and opens the shared details");
const ex = read("src/features/reports/billing-exception-ui.tsx");
assert.ok(ex.includes('"calendar", "calendar-upcoming"') && ui.includes('["calendar", "calendar-upcoming"]'), "creating or rescheduling refreshes the Calendar queries");
console.log("billing-task.test.tsx — all assertions passed");
