/**
 * Scheme Conversion is TEMPORARILY disabled in Daily Work (one switch: SCHEME_CONVERSION_ENABLED in src/lib/daily-work.ts).
 * Proves: hidden from the Plan Type tabs and unselectable; not a Save Draft / Submit / Report requirement; the other
 * sections' rules are unchanged; write routes reject it; nothing was deleted; re-enabling is the single flag.
 * (Backend submit/report behaviour end-to-end is covered by daily-work-completion.test.ts, whose fake day has NO
 * Scheme Conversion data and does not mark it No Plan, yet submits and finalizes.)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { testLoader } from "@/features/dealer-tags/test-loader";
import {
  ALL_DAILY_WORK_SECTIONS, MANDATORY_SECTIONS, SCHEME_CONVERSION_ENABLED, SectionStatus, canSubmitDailyWork, computeSectionStatuses,
  isDailyWorkSectionEnabled, parseNoPlanSet, resolveDailyWorkSection, sectionStatusCounts, serializeNoPlanSet, type SectionDataPresence,
} from "@/lib/daily-work";

const read = (p: string) => readFileSync(p, "utf8");
const full = (over: Partial<SectionDataPresence> = {}): SectionDataPresence => ({ SALES: true, RECOVERY: true, APPOINTMENT: true, SCHEME_CONVERSION: false, VISITS: true, OTHERS: true, ...over });

// 1, 2 — the switch is off: not offered, not selectable; every other section remains, in order.
assert.equal(SCHEME_CONVERSION_ENABLED, false);
assert.deepEqual([...MANDATORY_SECTIONS], ["SALES", "RECOVERY", "APPOINTMENT", "VISITS", "OTHERS"], "Plan Type tabs: Sales, Recovery, Dealer Appointment, Visits, Others");
assert.ok(!(MANDATORY_SECTIONS as readonly string[]).includes("SCHEME_CONVERSION"));
assert.equal(isDailyWorkSectionEnabled("SCHEME_CONVERSION"), false);
for (const s of ["SALES", "RECOVERY", "APPOINTMENT", "VISITS", "OTHERS"]) assert.equal(isDailyWorkSectionEnabled(s), true, s);
assert.equal(isDailyWorkSectionEnabled("bogus"), false); assert.equal(isDailyWorkSectionEnabled(null), false);

// 14 — a stale/old Scheme Conversion state resolves to an enabled section, and resolving is stable (no loop).
assert.equal(resolveDailyWorkSection("SCHEME_CONVERSION"), "SALES");
assert.equal(resolveDailyWorkSection("nonsense"), "SALES");
for (const s of ["SCHEME_CONVERSION", "VISITS", "x", undefined]) assert.equal(resolveDailyWorkSection(resolveDailyWorkSection(s)), resolveDailyWorkSection(s), "idempotent → no redirect loop");
assert.equal(resolveDailyWorkSection("VISITS"), "VISITS", "enabled sections are untouched");

// 3, 4, 5, 6 — the submit gate: Scheme Conversion data/No Plan is never needed; other sections still are.
const statuses = (data: SectionDataPresence, noPlan: string[] = []) => computeSectionStatuses(data, new Set(noPlan));
assert.equal(canSubmitDailyWork(statuses(full())), true, "all active sections filled, Scheme Conversion empty and not No Plan → can submit");
assert.deepEqual(sectionStatusCounts(statuses(full())), { filled: 5, noPlan: 0, remaining: 0, total: 5 }, "progress counts only active sections");
assert.equal(statuses(full())["SCHEME_CONVERSION" as never], undefined, "no status is produced for the disabled section");
for (const missing of ["SALES", "RECOVERY", "APPOINTMENT", "VISITS", "OTHERS"] as const) {
  assert.equal(canSubmitDailyWork(statuses(full({ [missing]: false }))), false, `${missing} is still required`);
  assert.equal(canSubmitDailyWork(statuses(full({ [missing]: false }), [missing])), true, `${missing} No Plan still resolves it`);
}
assert.equal(canSubmitDailyWork(statuses(full({ SCHEME_CONVERSION: true }))), true, "stray Scheme Conversion data does not matter either");
// 8–11 — data wins over No Plan exactly as before.
assert.equal(statuses(full(), ["SALES"]).SALES, SectionStatus.FILLED);

// 13 — stored No-Plan flags for the disabled section are preserved (parse/serialize keep them; they just don't count).
assert.ok(parseNoPlanSet("SALES,SCHEME_CONVERSION").has("SCHEME_CONVERSION"));
assert.equal(serializeNoPlanSet(new Set(["SCHEME_CONVERSION", "SALES"])), "SALES,SCHEME_CONVERSION", "no stored data is dropped on rewrite");
assert.equal(canSubmitDailyWork(statuses(full(), ["SCHEME_CONVERSION"])), true);

// 2 — UI: the tab strip iterates the active list; selection is resolved (fallback) before rendering.
const page = read("src/features/daily-work/daily-work-page.tsx");
assert.ok(page.includes("{MANDATORY_SECTIONS.map((s) => ("), "tabs come from the central list");
assert.ok(!/\(\["SALES", "RECOVERY", "APPOINTMENT", "SCHEME_CONVERSION"/.test(page), "no hard-coded tab list containing Scheme Conversion");
assert.ok(page.includes("const section = resolveDailyWorkSection(requestedSection)"), "stale section state falls back safely");
assert.ok(page.includes("function ConversionSection") && page.includes('section === "SCHEME_CONVERSION" ?'), "12: the Scheme Conversion UI code is preserved (just unreachable)");

// Backend: the section-level requirements all derive from the same central list; the report ignores disabled-section rows.
const service = read("src/features/daily-work/service.server.ts");
assert.ok(service.includes("${SCHEME_CONVERSION_ENABLED}::boolean OR"), "report completion ignores disabled-section rows");
for (const fn of ["getDailyConversion", "saveDailyConversion", "enterConversionAchievability", "submitDailyConversion"]) assert.ok(service.includes(`export async function ${fn}`), `12: ${fn} still exists`);
// Write routes reject the disabled section (409); GET stays open for history.
for (const route of ["save", "submit", "actual", "no-plan"]) assert.ok(read(`src/app/api/daily-work/${route}/route.ts`).includes("assertDailyWorkSectionWritable"), `${route} route guards writes`);
assert.ok(!read("src/app/api/daily-work/route.ts").includes("assertDailyWorkSectionWritable"), "reads (history / admin viewer) remain available");
assert.ok(service.includes("loadDailyRows(officerId, \"SCHEME_CONVERSION\""), "historical conversion reads untouched");

// 12, 13 — nothing deleted: Prisma schema + admin viewer + labels still know the section; no migration was added for this.
assert.ok(/SCHEME_CONVERSION|schemeId/.test(read("prisma/schema.prisma")));
assert.ok(read("src/features/daily-work/admin-daily-work-viewer.tsx").includes("SCHEME_CONVERSION"), "admin viewer can still show history");
assert.ok(read("src/features/labels/labels.ts").includes('"daily_work.section.scheme_conversion"'));
assert.ok(ALL_DAILY_WORK_SECTIONS.includes("SCHEME_CONVERSION"), "the section still exists in the model");

// 15 — re-enabling is ONE value: flip the flag in a copy of the real module and everything returns.
const src = read("src/lib/daily-work.ts");
assert.ok(/export const SCHEME_CONVERSION_ENABLED = false;/.test(src), "single, documented switch");
const base = testLoader({});
const seasonMonths = base<unknown>("src/lib/season-months.ts");
const enabled = (() => {
  const code = ts.transpileModule(src.replace("SCHEME_CONVERSION_ENABLED = false;", "SCHEME_CONVERSION_ENABLED = true;"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  runInNewContext(code, { module: mod, exports: mod.exports, require: () => seasonMonths, console });
  return mod.exports as unknown as typeof import("@/lib/daily-work");
})();
assert.deepEqual([...enabled.MANDATORY_SECTIONS], ["SALES", "RECOVERY", "APPOINTMENT", "SCHEME_CONVERSION", "VISITS", "OTHERS"], "re-enabled: tab and requirement return");
assert.equal(enabled.resolveDailyWorkSection("SCHEME_CONVERSION"), "SCHEME_CONVERSION");
assert.equal(enabled.canSubmitDailyWork(enabled.computeSectionStatuses(full(), new Set())), false, "re-enabled: Scheme Conversion is required again");
assert.equal(enabled.sectionStatusCounts(enabled.computeSectionStatuses(full(), new Set())).total, 6);

console.log("scheme-conversion-disabled.test.ts — all assertions passed");
