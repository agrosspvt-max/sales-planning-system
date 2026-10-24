/** Date column range filter: presets include today (Asia/Kolkata date supplied by the caller), Custom Range only applies on Apply, validation and cancel. No browser. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { inclusiveDays, matchPreset, presetRange, rangeProblem, PERFORMANCE_MAX_RANGE_DAYS } from "@/lib/date-range";

// ---- pure rules
assert.deepEqual(presetRange(7, "2026-10-24"), { from: "2026-10-18", to: "2026-10-24" }, "Last 7 Days on 24/10/2026 is 18/10 – 24/10 inclusive");
assert.deepEqual(presetRange(15, "2026-10-24"), { from: "2026-10-10", to: "2026-10-24" });
assert.deepEqual(presetRange(30, "2026-10-24"), { from: "2026-09-25", to: "2026-10-24" }, "month boundary");
assert.deepEqual(presetRange(7, "2026-01-03"), { from: "2025-12-28", to: "2026-01-03" }, "year boundary");
assert.deepEqual(presetRange(7, "2026-03-02"), { from: "2026-02-24", to: "2026-03-02" }, "non-leap February");
assert.deepEqual(presetRange(7, "2024-03-01"), { from: "2024-02-24", to: "2024-03-01" }, "leap February");
for (const d of [7, 15, 30] as const) assert.equal(inclusiveDays(presetRange(d, "2026-03-01").from, "2026-03-01"), d, `Last ${d} Days spans exactly ${d} calendar days`);
assert.equal(matchPreset("2026-10-18", "2026-10-24", "2026-10-24"), 7);
assert.equal(matchPreset("2026-10-24", "2026-10-24", "2026-10-24"), null, "today-only (the initial range) is a Custom Range");
assert.equal(matchPreset("2026-10-18", "2026-10-24", "2026-10-25"), null, "a preset that no longer ends today is custom");
assert.deepEqual([rangeProblem("", "2026-10-01"), rangeProblem("2026-10-01", ""), rangeProblem("2026-10-02", "2026-10-01"), rangeProblem("2026-10-01", "2026-10-01")], ["required", "required", "order", null]);
assert.equal(rangeProblem(presetRange(PERFORMANCE_MAX_RANGE_DAYS, "2026-10-24").from, "2026-10-24"), null, "the supported maximum is accepted");
assert.equal(rangeProblem(presetRange(PERFORMANCE_MAX_RANGE_DAYS + 1, "2026-10-24").from, "2026-10-24"), "too_large", "one day beyond the supported maximum is refused");

// ---- the header component
const L = DEFAULT_LABELS as Record<string, string>;
const hooks: unknown[] = []; let cursor = 0;
const dates: Record<string, { value: string; onChange: (v: string) => void }> = {};
const clicks: Record<string, () => void> = {};
const items: { range: string; onSelect: (e: { preventDefault: () => void }) => void; checked: boolean }[] = [];
const { DateRangeFilterHeader } = testLoader({
  react: { ...React, useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], (v: unknown) => { hooks[i] = v; }]; } },
  "@/components/ui/dropdown-menu": {
    DropdownMenu: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>, DropdownMenuTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>, DropdownMenuContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuItem: (p: { children?: React.ReactNode; onSelect: (e: { preventDefault: () => void }) => void; "data-range-option": string; "aria-checked": boolean }) => { items.push({ range: p["data-range-option"], onSelect: p.onSelect, checked: p["aria-checked"] }); return <div data-option={p["data-range-option"]} aria-checked={p["aria-checked"]}>{p.children}</div>; },
  },
  "@/components/ui/date-input-dmy": { DateInputDMY: (p: { value: string; onChange: (v: string) => void; "aria-label": string }) => { dates[p["aria-label"]] = p; return <input aria-label={p["aria-label"]} value={p.value} readOnly />; } },
  "@/components/ui/button": { Button: (p: { children?: React.ReactNode; onClick?: () => void }) => { if (typeof p.children === "string" && p.onClick) clicks[p.children] = p.onClick; return <button>{p.children}</button>; } },
  "@/components/ui/table": { TableHead: ({ children }: { children?: React.ReactNode }) => <th>{children}</th> },
})("src/components/ui/date-range-filter-header.tsx") as { DateRangeFilterHeader: React.ComponentType<Record<string, unknown>> };
const text = { last7: L["daily_work.performance.range.last7"], last15: L["daily_work.performance.range.last15"], last30: L["daily_work.performance.range.last30"], custom: L["daily_work.performance.range.custom"], start: L["daily_work.performance.range.start"], end: L["daily_work.performance.range.end"], apply: L["daily_work.performance.range.apply"], cancel: L["daily_work.performance.range.cancel"], applied: L["daily_work.performance.range.applied"], span: L["daily_work.performance.range.span"], problems: { required: "need both", order: "start after end", too_large: "too long" } };
const applied: [string, string][] = [];
const render = (from: string, to: string) => { cursor = 0; items.length = 0; const h = renderToStaticMarkup(<DateRangeFilterHeader label="Date" ariaLabel="Filter by date" from={from} to={to} today="2026-10-24" onApply={(f: string, t: string) => applied.push([f, t])} text={text} />); hooks.length = cursor; return h; };

let html = render("2026-10-18", "2026-10-24");
assert.deepEqual([...html.matchAll(/data-option="([^"]+)"/g)].map((m) => m[1]), ["last-7", "last-15", "last-30", "custom"], "options in order");
assert.ok(html.includes(text.last7) && html.includes(text.custom) && html.includes("Applied: 18/10/2026 – 24/10/2026"), "labels come from Labels and the applied range is shown in DD/MM/YYYY");
assert.deepEqual(items.map((i) => i.checked), [true, false, false, false], "the matching preset is marked selected");
assert.ok(!html.includes('data-testid="date-range-custom"'), "no custom fields until Custom Range is chosen");
items[1]!.onSelect({ preventDefault: () => undefined });
assert.deepEqual(applied.at(-1), ["2026-10-10", "2026-10-24"], "a preset applies immediately, including today");
items[2]!.onSelect({ preventDefault: () => undefined });
assert.deepEqual(applied.at(-1), ["2026-09-25", "2026-10-24"]);

// Custom: nothing applies until Apply; the initial today-only range shows Custom Range selected with the fields revealed.
applied.length = 0; hooks.length = 0;
html = render("2026-10-24", "2026-10-24");
assert.equal(items.find((i) => i.range === "custom")!.checked, true, "an unmatched range shows Custom Range as selected");
items.find((i) => i.range === "custom")!.onSelect({ preventDefault: () => undefined }); html = render("2026-10-24", "2026-10-24");
assert.ok(html.includes('data-testid="date-range-custom"') && html.includes(text.start) && html.includes(text.end), "Start Date / End Date fields appear");
dates[text.start]!.onChange("2026-10-01"); dates[text.end]!.onChange("2026-10-20"); html = render("2026-10-24", "2026-10-24");
assert.equal(applied.length, 0, "editing the dates does not apply anything");
dates[text.start]!.onChange("2026-10-25"); render("2026-10-24", "2026-10-24"); clicks[text.apply]!(); html = render("2026-10-24", "2026-10-24");
assert.ok(html.includes("start after end") && applied.length === 0, "a start date later than the end date is refused");
dates[text.start]!.onChange(""); render("2026-10-24", "2026-10-24"); clicks[text.apply]!(); html = render("2026-10-24", "2026-10-24");
assert.ok(html.includes("need both") && applied.length === 0, "both dates are required");
dates[text.start]!.onChange("2026-01-01"); render("2026-10-24", "2026-10-24"); clicks[text.apply]!(); html = render("2026-10-24", "2026-10-24");
assert.ok(html.includes("too long") && applied.length === 0, "the supported maximum range is kept");
dates[text.start]!.onChange("2026-10-01"); dates[text.end]!.onChange("2026-10-20"); render("2026-10-24", "2026-10-24"); clicks[text.apply]!();
assert.deepEqual(applied, [["2026-10-01", "2026-10-20"]], "Apply commits exactly the chosen range");
// Cancel keeps the previously applied range.
applied.length = 0; hooks.length = 0; render("2026-10-24", "2026-10-24");
dates[text.start]!.onChange("2026-10-02"); render("2026-10-24", "2026-10-24"); clicks[text.cancel]!(); html = render("2026-10-24", "2026-10-24");
assert.equal(applied.length, 0, "Cancel applies nothing");
assert.equal(dates[text.start]!.value, "2026-10-24", "drafts return to the applied range");
// ---- applied-filter indicator under the heading (derived from the APPLIED range only)
{
  hooks.length = 0;
  const indicator = (h: string) => /data-testid="date-range-indicator"[^>]*>([^<]*)</.exec(h)![1];
  const full = (h: string) => /title="([^"]*)" data-testid="date-range-indicator"/.exec(h)![1];
  for (const [d, name] of [[7, text.last7], [15, text.last15], [30, text.last30]] as const) {
    const r = presetRange(d, "2026-10-24");
    const h = render(r.from, r.to);
    assert.equal(indicator(h), name, `Last ${d} Days is named under the heading`);
    assert.equal(full(h).replace("–", "-"), `Applied: ${r.from.split("-").reverse().join("/")} - 24/10/2026`.replace("–", "-"), `the exact dates of Last ${d} Days are in the tooltip`);
  }
  assert.ok(render("2026-10-18", "2026-10-24").includes("sr-only") && render("2026-10-18", "2026-10-24").includes("aria-describedby"), "the exact dates are also an accessible description");
  assert.equal(indicator(render("2026-10-01", "2026-10-24")), "01/10/2026 – 24/10/2026", "a Custom Range shows its actual dates");
  assert.ok(render("2026-10-01", "2026-10-24").includes("text-primary"), "the indicator uses the active-filter blue");
  // Unsaved drafts never change it; Cancel keeps it; Apply updates it (via the new applied props).
  hooks.length = 0; render("2026-10-01", "2026-10-24");
  items.find((i) => i.range === "custom")!.onSelect({ preventDefault: () => undefined }); render("2026-10-01", "2026-10-24");
  dates[text.start]!.onChange("2026-09-01"); dates[text.end]!.onChange("2026-09-30");
  assert.equal(indicator(render("2026-10-01", "2026-10-24")), "01/10/2026 – 24/10/2026", "editing the dates does not alter the indicator");
  clicks[text.cancel]!();
  assert.equal(indicator(render("2026-10-01", "2026-10-24")), "01/10/2026 – 24/10/2026", "Cancel retains it");
  assert.equal(indicator(render("2026-09-01", "2026-09-30")), "01/09/2026 – 30/09/2026", "after Apply the parent passes the new range and the indicator follows");
  assert.equal(indicator(render("2026-10-24", "2026-10-24")), "24/10/2026 – 24/10/2026", "the default today-only range is represented too");
}
console.log("date-range-filter-header.test.tsx — all assertions passed");
