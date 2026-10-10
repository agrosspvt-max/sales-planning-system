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
console.log("performance-labels.test.tsx — all assertions passed");
