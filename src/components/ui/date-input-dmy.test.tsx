/** Performance Date From / Date To: always DD/MM/YYYY on screen, ISO YYYY-MM-DD inside, no time-zone shift. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { displayToIso, isoToDisplay, isRealDate, maskDisplayInput } from "@/lib/date-input";
import { testLoader } from "@/features/dealer-tags/test-loader";

// Pure conversion: ISO ⇄ DD/MM/YYYY.
assert.equal(isoToDisplay("2026-10-09"), "09/10/2026");
assert.equal(isoToDisplay("2026-01-05"), "05/01/2026", "day and month are never swapped (05/01 is 5 January, not 1 May)");
assert.equal(isoToDisplay("2026-12-31"), "31/12/2026");
assert.equal(displayToIso("09/10/2026"), "2026-10-09");
assert.equal(displayToIso("05/01/2026"), "2026-01-05");
for (const iso of ["2026-01-01", "2026-02-28", "2028-02-29", "2026-03-29", "2026-10-25", "2026-12-31", "1999-07-04"]) assert.equal(displayToIso(isoToDisplay(iso)), iso, `round trip ${iso}`);
// Impossible / incomplete input is never turned into a date.
for (const bad of ["31/02/2026", "29/02/2026", "00/10/2026", "10/13/2026", "10/00/2026", "9/10/2026", "09-10-2026", "09/10/26", "2026-10-09", "", "aa/bb/cccc", "32/01/2026"]) assert.equal(displayToIso(bad), null, `${JSON.stringify(bad)} is not a date`);
assert.equal(displayToIso("29/02/2028"), "2028-02-29", "leap day");
assert.equal(displayToIso("29/02/2100"), null, "2100 is not a leap year");
for (const bad of ["", "2026-13-01", "2026-02-30", "26-10-09", "x"]) assert.equal(isoToDisplay(bad), "", `${JSON.stringify(bad)} shows blank`);
assert.equal(isRealDate(2026, 4, 31), false); assert.equal(isRealDate(2026, 4, 30), true);
// Typing mask.
assert.deepEqual(["0", "09", "091", "0910", "09102", "09102026", "091020261", "09/10/2026", "9a1b0", "  "].map(maskDisplayInput), ["0", "09", "09/1", "09/10", "09/10/2", "09/10/2026", "09/10/2026", "09/10/2026", "91/0", ""]);

// Rendering: whatever the browser locale, the visible text is DD/MM/YYYY; the committed value stays ISO (no Date object → no time-zone shift).
const { DateInputDMY } = testLoader({ "lucide-react": { CalendarDays: () => <svg /> } })("src/components/ui/date-input-dmy.tsx") as { DateInputDMY: React.ComponentType<{ value: string; onChange: (v: string) => void; "aria-label"?: string }> };
const html = renderToStaticMarkup(<DateInputDMY value="2026-10-09" onChange={() => undefined} aria-label="Date From" />);
assert.ok(html.includes('value="09/10/2026"') && html.includes('placeholder="DD/MM/YYYY"') && html.includes('aria-label="Date From"'), "shows 09/10/2026");
assert.ok(html.includes('type="date"') && html.includes('value="2026-10-09"') && html.includes('aria-hidden="true"'), "the picker's own value is the ISO key");
assert.ok(renderToStaticMarkup(<DateInputDMY value="2026-01-05" onChange={() => undefined} />).includes('value="05/01/2026"'));
assert.ok(renderToStaticMarkup(<DateInputDMY value="" onChange={() => undefined} />).includes('value=""'));
const src = readFileSync("src/lib/date-input.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
assert.ok(!/new Date|Date\.|toLocale|Intl\./.test(src), "string handling only — no locale or time-zone conversion");


// Behaviour: typing commits only a COMPLETE, REAL date (as ISO); partial / impossible text is never emitted and reverts on blur; clearing falls back via ""; the picker emits ISO.
{
  const hooks: unknown[] = []; let cursor = 0;
  const { DateInputDMY: Raw } = testLoader({
    "lucide-react": { CalendarDays: () => null },
    react: { ...React, useState: (init: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = init; return [hooks[i], (u: unknown) => { hooks[i] = u; }]; } },
  })("src/components/ui/date-input-dmy.tsx") as { DateInputDMY: (p: { value: string; onChange: (v: string) => void }) => React.ReactElement<{ children: React.ReactElement<Record<string, unknown>>[] }> };
  const emitted: string[] = [];
  const view = (value = "2026-10-09") => { cursor = 0; const tree = Raw({ value, onChange: (v) => emitted.push(v) }); const [text, , picker] = tree.props.children; return { text: text!.props as { value: string; onChange: (e: unknown) => void; onBlur: () => void }, picker: picker!.props as { onChange: (e: unknown) => void } }; };
  const type = (t: string) => view().text.onChange({ target: { value: t } });
  type("1/1"); assert.deepEqual(emitted, [], "incomplete text emits nothing"); assert.equal(view().text.value, "11", "…and is shown as typed (masked)");
  type("31022026"); assert.deepEqual(emitted, [], "31/02/2026 is not a date → nothing emitted");
  view().text.onBlur(); assert.equal(view().text.value, "09/10/2026", "blur reverts to the last good value");
  type("15/08/2026"); assert.deepEqual(emitted, ["2026-08-15"], "a complete real date is emitted as ISO");
  type("05012026"); assert.equal(emitted.at(-1), "2026-01-05", "05/01/2026 is 5 January");
  type(""); view().text.onBlur(); assert.equal(emitted.at(-1), "", "cleared + left → '' (the page then applies its own default)");
  view().picker.onChange({ target: { value: "2026-11-30" } }); assert.equal(emitted.at(-1), "2026-11-30", "calendar pick passes the ISO value through untouched");
  const count = emitted.length;
  view().picker.onChange({ target: { value: "" } }); assert.equal(emitted.length, count, "an empty pick is ignored")
}

// Wiring: Date From / Date To use it on every Performance view (My / Team / Company share performance-page; the RM team page has its own filters); state and API stay ISO.
for (const f of ["src/features/daily-work/performance-page.tsx", "src/features/daily-work/team-performance-page.tsx"]) {
  const page = readFileSync(f, "utf8");
  assert.ok(page.includes("<DateInputDMY value={from} onChange={(v) => setFrom(v || currentBusinessDate())}") && page.includes("<DateInputDMY value={to} onChange={(v) => setTo(v || currentBusinessDate())}"), `${f}: Date From / Date To`);
  assert.ok(!/type="date"/.test(page), `${f}: no native date input left`);
  assert.ok(/useState\(currentBusinessDate\)/.test(page) && /new URLSearchParams\(\{ from, to \}\)|query = new URLSearchParams\(\{ from, to \}\)/.test(page), `${f}: default range and the from/to API parameters are unchanged (ISO)`);
}
// Other date inputs in the app are untouched.
for (const f of ["src/features/audit/audit-page.tsx", "src/features/sales-upload/wizard.tsx", "src/features/party-planning/monthly-planning-page.tsx"]) assert.ok(readFileSync(f, "utf8").includes('type="date"'), `${f} unchanged`);
console.log("date-input-dmy.test.tsx — all assertions passed");
