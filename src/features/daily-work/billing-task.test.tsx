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
  "@/components/ui/dialog": { Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>, DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
  "@/components/ui/date-input-dmy": { DateInputDMY: ({ min, "aria-label": al }: { min?: string; "aria-label"?: string }) => <input type="text" placeholder="DD/MM/YYYY" min={min} aria-label={al} /> },
});
const { BillingTaskRescheduleDialog, dayAfter } = load<typeof import("./billing-task-ui")>("src/features/daily-work/billing-task-ui.tsx");
const T = { taskId: "t1", billingExceptionId: "e1", dealerId: "d1", dealerName: "Beta Stores", taskType: "BILLING_EXCEPTION", planType: "RECOVERY", amount: 20000, promisedDate: "2026-10-09", taskDate: "2026-10-12", rescheduled: false, confirmed: false, overdue: false, billNo: "B-1", authPerson: "Varun sir" };
const out = renderToStaticMarkup(<BillingTaskRescheduleDialog task={T as never} today="2026-10-14" onClose={() => {}} onDone={() => {}} />);

// the reschedule popup: dealer, read-only planned amount, current date (DD/MM/YYYY), a date picker, Save / Cancel
for (const needle of ["Beta Stores", "₹20,000", "12/10/2026", "Planned amount", "Current scheduled date", "New date", ">Reschedule<", ">Cancel<", "DD/MM/YYYY"]) assert.ok(out.includes(needle), needle);
assert.ok(!/<input[^>]*value="20000"/.test(out) && out.includes('data-testid="reschedule-amount"'), "the amount is plain text, never an input");
assert.equal(dayAfter("2026-10-14"), "2026-10-15"); assert.equal(dayAfter("2026-12-31"), "2027-01-01"); assert.equal(dayAfter("2028-02-28"), "2028-02-29");
assert.ok(/min="2026-10-15"/.test(out), "the picker starts the day AFTER today");

/* ---- wiring ---- */
const read = (p: string) => readFileSync(p, "utf8");
const ui = read("src/features/daily-work/billing-task-ui.tsx"), server = read("src/features/daily-work/billing-task.server.ts");
assert.ok(!/cn-requests|CnPaymentEvent|CnRequest/.test(ui + server.replace(/NOT EXISTS \(SELECT 1 FROM "Cn\w+" x WHERE [^)]*\)/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "no CN endpoint, table or id is used by the Billing Exception source");
assert.ok(ui.includes("/api/billing-exception-tasks/${task.taskId}/reschedule") && ui.includes("/api/billing-exception-tasks/${id}") && !ui.includes("/confirm"), "its own endpoints; no confirmation endpoint");
const page = read("src/features/daily-work/daily-work-page.tsx");
assert.ok(!page.includes("BillingTaskPanel") && !ui.includes("BillingTaskPanel") && !page.includes("billing-task-panel"), "the separate Billing Exception tasks section is gone");
assert.ok(page.includes("<BillingTaskRescheduleDialog") && page.includes('data-testid="billing-reschedule-icon"') && page.includes('r.rowKind === "MANUAL" && <Button') && page.includes("(data?.billingTasks ?? []).filter((t) => t.entryId === r.entryId)"), "the calendar icon is on the task's OWN row (bound to its entry id, never to the dealer); only the manual row has a delete icon");
assert.ok(page.includes("readOnly={r.amountLocked}") && page.includes("data-auto-locked"), "an Auto amount is read-only");
assert.ok(!/confirmBillingTask|countUnconfirmedBillingTasks|billing-exception-tasks\/\[id\]\/confirm/.test(read("src/features/daily-work/billing-task.server.ts") + read("src/features/daily-work/service.server.ts")), "no confirmation requirement is left for Billing Exception tasks");
assert.ok(page.includes("billingEntrySet") && page.includes('billingEntrySet.has(entryId) ? "AUTO"'), "Task Type: a Billing Exception task row is Auto");
assert.ok(!page.includes("taskTypeBilling") && page.includes("data-recovery-source") && page.includes("sourceBilling"), "its source is the (locked) Recovery Type, not the Task Type");
const service = read("src/features/daily-work/service.server.ts");
assert.ok(service.includes("${BILLING_CONTRIBUTION_UNION}") && service.includes("billingTasks,") && service.includes("billingEntryIds,"), "Today's Plan floor, submit gate and payload include the source");
const auto = read("src/features/daily-work/auto-task-materialization.server.ts");
assert.ok(auto.includes("materializeDueBillingTasksInTransaction(tx, officerId, workDate, day)") && auto.includes("cn.materializedTasks + billing.materialized"), "one materialization entry point for every read path and submit gate, counts combined (a newly added task blocks finalization like a CN task)");
assert.ok(/SELECT "id" FROM "BillingExceptionTask" WHERE "id" = \$\{id\} FOR UPDATE/.test(server) && server.indexOf("lockDailyWorkDay(tx, peek.officerId, workDate)") < server.indexOf("const task = await loadLocked(tx, id)"), "lock order: Daily Work day, then the task row");
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
