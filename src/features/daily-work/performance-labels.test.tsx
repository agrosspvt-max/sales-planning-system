/** Performance module: every static string comes from Edit Labels (registered key), and the six Daily Work Review empty states are individually editable. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS, labelMeta } from "@/features/labels/labels";

const edited: Record<string, string> = {};
const overrides = {
  "@/features/labels/label-ui": { useLabel: (k: string) => edited[k] ?? (DEFAULT_LABELS as Record<string, string>)[k] ?? k },
  "@/features/dealers/dealer-name-ui": { DealerName: ({ name }: { name: string }) => <>{name}</> },
  "@/features/dealers/dealer-table-ui": { DealerTableBody: ({ children }: { children?: React.ReactNode }) => <tbody>{children}</tbody> },
  "@tanstack/react-query": { useQuery: () => ({ data: undefined, isLoading: false }), useQueryClient: () => ({}), useMutation: () => ({ isPending: false, mutate: () => undefined }) },
  "@/lib/api-client": { api: {} },
};
const m = testLoader(overrides)("src/features/daily-work/team-performance-page.tsx") as Record<string, React.ComponentType<Record<string, unknown>>>;
const visits = { visitsEntered: false, dealerVisits: 0, newPartyVisits: 0, others: "" };
const cases: [string, string, () => React.ReactElement, string][] = [
  ["daily_work.review.no_data_sales", "No Sales data", () => <m.DealerSection title="Sales" rows={[]} />, "Sales"],
  ["daily_work.review.no_data_recovery", "No Recovery data", () => <m.DealerSection title="Recovery" rows={[]} recovery />, "Recovery"],
  ["daily_work.review.no_data_appointment", "No Dealer Appointment data", () => <m.AppointmentSection title="Dealer Appointment" rows={[]} />, "Appt"],
  ["daily_work.review.no_data_scheme_conversion", "No Scheme Conversion data", () => <m.ConversionSection title="Scheme Conversion" rows={[]} />, "Conv"],
  ["daily_work.review.no_data_visits", "No Visits data", () => <m.VisitsSection title="Visits" summary={visits} />, "Vis"],
  ["daily_work.review.no_data_others", "No Others data", () => <m.OthersSection title="Others" text=" " />, "Oth"],
];
// 1. Defaults keep the exact existing wording; each is registered in the Edit Labels catalogue; an edit changes only that section.
for (const [key, text, render] of cases.map(([k, t, r]) => [k, t, r] as const)) {
  assert.equal((DEFAULT_LABELS as Record<string, string>)[key], text, `default wording: ${key}`);
  assert.ok(key in labelMeta || key in DEFAULT_LABELS, `registered: ${key}`);
  assert.ok(renderToStaticMarkup(render()).includes(text), `renders default: ${text}`);
}
for (const [key, , render, tag] of cases) {
  edited[key] = `Nothing for ${tag}`;
  assert.ok(renderToStaticMarkup(render()).includes(`Nothing for ${tag}`), `edited label shown: ${key}`);
  for (const [otherKey, otherText, otherRender] of cases) if (otherKey !== key) assert.ok(renderToStaticMarkup(otherRender()).includes(otherText), `${otherKey} unaffected by editing ${key}`);
  delete edited[key];
}
assert.equal((DEFAULT_LABELS as Record<string, string>)["daily_work.review.unavailable"], "Unavailable.");

// 2. Audit: no hardcoded user-visible strings remain in the Performance files (JSX text, or text-bearing props).
const files = ["performance-page", "team-performance-page", "performance-metric-detail"].map((f) => [f, readFileSync(`src/features/daily-work/${f}.tsx`, "utf8")] as const);
for (const [f, src] of files) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const mt of code.matchAll(/<[A-Za-z][\w.]*(?:\s[^<>]*)?>\s*([A-Za-z][A-Za-z ,'’-]{2,})\s*<\//g)) assert.fail(`${f}: hardcoded JSX text "${mt[1]}"`);
  for (const mt of code.matchAll(/\b(?:placeholder|title|aria-label|label|alt)=\"([^\"]+)\"/g)) assert.fail(`${f}: hardcoded ${mt[0]}`);
  for (const mt of code.matchAll(/\?\?\s*\"([^\"]+)\"/g)) assert.fail(`${f}: hardcoded fallback text "${mt[1]}"`);
  for (const key of code.matchAll(/useLabel\("([^"]+)"\)/g)) assert.ok(key[1]! in DEFAULT_LABELS, `${f}: unregistered label ${key[1]}`);
}

// 3. No Plan: ONE shared label (Edit Labels), bold under each section heading, only from the explicit saved state.
import { sectionSavedAsNoPlan } from "@/lib/daily-work";
const NP = "daily_work.action.no_plan";
assert.equal((DEFAULT_LABELS as Record<string, string>)[NP], "No Plan", "default text");
assert.ok(!("daily_work.status.no_plan" in DEFAULT_LABELS), "no second, unused No Plan key");
const row = { dealerId: "d1", dealerName: "Alpha", todaysPlan: 100, todaysActual: 90 };
const noPlanCases: [string, (np: boolean) => React.ReactElement, string][] = [
  ["Sales", (np) => <m.DealerSection title="Sales" rows={[]} noPlan={np} />, "No Sales data"],
  ["Recovery", (np) => <m.DealerSection title="Recovery" rows={[]} recovery noPlan={np} />, "No Recovery data"],
  ["Appt", (np) => <m.AppointmentSection title="Dealer Appointment" rows={[]} noPlan={np} />, "No Dealer Appointment data"],
  ["Conv", (np) => <m.ConversionSection title="Scheme Conversion" rows={[]} noPlan={np} />, "No Scheme Conversion data"],
  ["Vis", (np) => <m.VisitsSection title="Visits" summary={visits} noPlan={np} />, "No Visits data"],
  ["Oth", (np) => <m.OthersSection title="Others" text=" " noPlan={np} />, "No Others data"],
];
for (const [name, render, oldMessage] of noPlanCases) {
  let out = renderToStaticMarkup(render(true));
  assert.ok(/<p[^>]*font-bold[^>]*data-no-plan="[^"]+"[^>]*>No Plan<\/p>/.test(out) && !out.includes(oldMessage), `${name}: bold No Plan replaces "${oldMessage}"`);
  assert.ok(out.indexOf("<h3") < out.indexOf("No Plan"), `${name}: No Plan sits beneath the heading`);
  out = renderToStaticMarkup(render(false));
  assert.ok(out.includes(oldMessage) && !out.includes("No Plan"), `${name}: an empty section that was NOT saved as No Plan keeps its own message`);
  edited[NP] = "Not Planned";
  out = renderToStaticMarkup(render(true));
  assert.ok(/font-bold[^>]*>Not Planned</.test(out) && !out.includes(">No Plan<"), `${name}: editing the label updates the display and keeps it bold`);
  delete edited[NP];
}
// Populated sections ignore the flag (data always wins) and keep their values.
assert.ok(renderToStaticMarkup(<m.DealerSection title="Sales" rows={[row]} noPlan />).includes("Alpha") && !renderToStaticMarkup(<m.DealerSection title="Sales" rows={[row]} noPlan />).includes("No Plan"), "populated section unchanged");
// The saved-state rule: every submitted batch must carry it; none / empty / other sections never count.
const b = (csv: string | null) => ({ noPlanSections: csv });
assert.equal(sectionSavedAsNoPlan([b("SALES,RECOVERY")], "SALES"), true);
assert.equal(sectionSavedAsNoPlan([b("SALES,RECOVERY")], "APPOINTMENT"), false, "mixed record: only the saved sections");
assert.equal(sectionSavedAsNoPlan([b("SALES"), b(null)], "SALES"), false, "one batch with plan data/none saved → not No Plan");
assert.equal(sectionSavedAsNoPlan([], "SALES"), false, "no submitted batch (unsubmitted plan/report) is never No Plan");
assert.equal(sectionSavedAsNoPlan(undefined, "SALES"), false);
assert.equal(sectionSavedAsNoPlan([b("")], "SALES"), false, "an empty section is not No Plan");
// Scheme Conversion (switched off in Daily Work): batches submitted since carry no decision, so one explicit saved No Plan counts — and only an explicit one.
assert.equal(sectionSavedAsNoPlan([b("SALES,SCHEME_CONVERSION")], "SCHEME_CONVERSION"), true, "explicit Scheme Conversion No Plan");
assert.equal(sectionSavedAsNoPlan([b("SCHEME_CONVERSION"), b("SALES")], "SCHEME_CONVERSION"), true, "…even when a later batch (submitted while the section was off) has no decision");
assert.equal(sectionSavedAsNoPlan([b("SALES,RECOVERY"), b(null)], "SCHEME_CONVERSION"), false, "no explicit selection → the normal empty message");
assert.equal(sectionSavedAsNoPlan([], "SCHEME_CONVERSION"), false);
// Wiring: every place uses the one key.
for (const f of ["team-performance-page", "daily-work-page", "admin-daily-work-viewer"]) {
  const src = readFileSync(`src/features/daily-work/${f}.tsx`, "utf8");
  assert.ok(src.includes(`"${NP}"`), `${f} reads the shared No Plan label`);
  assert.ok(!/>\s*No Plan\s*</.test(src) && !/aria-label="No Plan"/.test(src), `${f}: no hard-coded No Plan text`);
}
assert.ok(readFileSync("src/features/daily-work/admin-daily-work-viewer.tsx", "utf8").includes("strong"), "admin report: bold");
console.log("performance-labels.test.tsx — all assertions passed");
