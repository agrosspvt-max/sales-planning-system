/** Focused source contracts for the role-aware, read-only Admin Daily Work viewer. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const viewer = readFileSync(resolve("src/features/daily-work/admin-daily-work-viewer.tsx"), "utf8");
const page = readFileSync(resolve("src/features/daily-work/daily-work-page.tsx"), "utf8");
const route = readFileSync(resolve("src/app/api/daily-work/admin-view/route.ts"), "utf8");
const server = readFileSync(resolve("src/features/daily-work/service.server.ts"), "utf8");

assert.ok(page.includes("isAdministrativeRole(role) ? <AdminDailyWorkViewer /> : <OwnerDailyWorkPage />"));

assert.ok(viewer.includes("<DailyWorkFieldset legend={L.planReport}>"));
assert.ok(viewer.includes('api.get<GroupOption[]>("/api/groups")'), "State reuses authoritative UserGroup endpoint");
assert.ok(viewer.includes("/api/users/officers?filter=active&groupId="), "SO list is server-scoped by State");
assert.ok(viewer.includes('setGroupId(value); setOfficerId("")'), "State change resets SO");

assert.ok(viewer.includes('["daily-work-admin-report", workDate, groupId, officerId]'));
assert.ok(viewer.includes("/api/daily-work/admin-view?"));
assert.ok(!viewer.includes("api.post("), "Admin viewer exposes no mutation request");
assert.ok(!viewer.includes("Save Draft") && !viewer.includes("Add Dealer") && !viewer.includes("Save Actuals"), "Admin viewer has no owner editing controls");
assert.ok(!route.includes("export async function POST"), "Admin report endpoint is read-only");

for (const section of ["SALES", "RECOVERY", "APPOINTMENT", "SCHEME_CONVERSION", "VISITS", "OTHERS"]) {
  assert.ok(viewer.includes(section), `Admin viewer includes ${section}`);
}
for (const label of [
  "daily_work.col.monthly_sales_plan", "daily_work.col.todays_sales",
  "daily_work.col.monthly_recovery_plan", "daily_work.col.todays_recovery",
  "daily_work.col.monthly_dealer_plan", "daily_work.col.appointment_status",
  "daily_work.col.planned_scheme_units", "daily_work.col.todays_conversion",
  "daily_work.visits.planned_dealer_visits", "daily_work.visits.actual_dealer_visits",
]) assert.ok(viewer.includes(label), `Admin viewer renders ${label}`);

assert.ok(viewer.includes("combineDailyWorkRows("));
assert.ok(viewer.includes("combineAppointmentRows("));
assert.ok(viewer.includes("combineConversionRows("));
assert.ok(viewer.includes('useLabel("daily_work.combined.none")'));
assert.ok(viewer.includes("<TableCell>{L.none}</TableCell>"));

assert.ok(server.includes("autoTaskEntryIdsForReport"));
assert.ok(server.includes('e."dailyWorkEntryId"'));
assert.ok(server.includes('c."legacyDailyWorkEntryId"'));
assert.ok(viewer.includes("new Set(data.autoTaskEntryIds)"));

assert.ok(server.includes("!isAdministrativeRole(ctx.role)"));
assert.ok(server.includes("officer.role !== Role.SALES_OFFICER"));
assert.ok(server.includes("officer.groupId !== groupId"));
assert.ok(server.includes("return getDailyWorkReviewDetail(ctx, officerId, workDate)"), "existing report source of truth is reused");

console.log("admin-daily-work-viewer.test.ts — all assertions passed");
