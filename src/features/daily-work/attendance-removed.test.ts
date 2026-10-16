/** Attendance is retired from the application: no code reads, writes, permits, labels or shows it. Historical storage is untouched (and unused). */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { ADMIN_MODULES } from "@/features/accounts/permissions";

const files: string[] = [];
const walk = (dir: string) => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(name) && !/\.(test|integration)\./.test(name)) files.push(p); } };
walk("src");
const offenders = files.filter((f) => /attendance/i.test(readFileSync(f, "utf8")));
assert.deepEqual(offenders, [], "no active application code mentions Attendance");
assert.equal(existsSync("src/app/api/daily-work/attendance/route.ts"), false, "the attendance endpoint is gone");
assert.deepEqual(Object.keys(DEFAULT_LABELS).filter((k) => /attendance/i.test(k) || /attendance/i.test(String(DEFAULT_LABELS[k as keyof typeof DEFAULT_LABELS]))), [], "no Attendance label is registered");
const performance = ADMIN_MODULES.find((m) => m.id === "performance")!;
assert.deepEqual(performance.actions, ["read"], "Performance has no 'Edit attendance' permission");
// The historical table is kept in the schema (no data is dropped) but nothing in src touches it.
assert.ok(readFileSync("prisma/schema.prisma", "utf8").includes("model DailyWorkAttendance"), "historical storage is retained");
assert.ok(readdirSync("prisma/migrations").some((m) => /attendance/i.test(readFileSync(join("prisma/migrations", m, "migration.sql"), "utf8"))), "existing migrations are untouched");
console.log("attendance-removed.test.ts — all assertions passed");
