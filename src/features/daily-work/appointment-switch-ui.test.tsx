/** Render the actual appointment table in both modes and exercise its input/result/save wiring. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import { DEFAULT_LABELS, type LabelKey } from "@/features/labels/labels";
import * as daily from "@/lib/daily-work";

const page = readFileSync("src/features/daily-work/daily-work-page.tsx", "utf8");
const source = page.slice(page.indexOf("const taskTypeText ="), page.indexOf("/*", page.indexOf("const taskTypeText ="))) + page.slice(page.indexOf("let apptSeq = 0;"), page.indexOf("/**", page.indexOf("let apptSeq = 0;")))
  + page.slice(page.indexOf("function AppointmentSection("), page.indexOf("/* ==================================== SECTION 4"))
  + "\nexports.AppointmentSection = AppointmentSection; exports.newApptRow = newApptRow;";
type Row = { entryId: string; rowId: string; batchId: string; monthlyPlanId: string; marketName: string; dealerName: string; legacy: boolean; monthlyStatus: string | null; resultEventId: string | null; reportedDealerName: string; status: string; rowStatus: string };
let enabled = false, renderCursor = 0;
let states: unknown[] = [];
let effects: (() => void)[] = [];
const inputProps: React.InputHTMLAttributes<HTMLInputElement>[] = [];
const selectProps: { onChange: (e: { target: { value: string } }) => void; disabled?: boolean }[] = [];
const buttons: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }[] = [];
let dropdown: { onChange: (value: string) => void } | undefined;
let saveDraft: () => Promise<void>;
const requests: { url: string; payload: Record<string, unknown> }[] = [];
const requireLocal = createRequire(import.meta.url);
const tag = (name: string) => function TestTableTag({ children, ...props }: { children?: React.ReactNode }) { return React.createElement(name, props, children); };
const mod = { exports: {} as { AppointmentSection: React.ComponentType<{ workDate: string; view: string; locked: boolean }>; newApptRow: (enabled: boolean) => Row } };
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
  exports: mod.exports, require: requireLocal, Date, console,
  useState: (initial: unknown) => { const i = renderCursor++; if (!(i in states)) states[i] = initial; return [states[i], (value: unknown) => { states[i] = typeof value === "function" ? value(states[i]) : value; }]; },
  useEffect: (effect: () => void) => { effects.push(effect); }, useRef: () => ({ current: false }), useMemo: (fn: () => unknown) => fn(),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
  useQuery: () => ({ isLoading: false, data: { partyPlanningEnabled: enabled, rows: states[0], eligibleMarkets: [{ monthlyPlanId: "p1", marketName: "Karuaa", monthlyStatus: "NONE" }], monthlyDealerPlan: 1, pending: 1, canEnterStatus: true, calendarEntryIds: [] } }),
  useLabel: (key: LabelKey) => DEFAULT_LABELS[key],
  useReportNoPlan: () => ({ is: () => false, label: "No Plan" }),
  useDailyAutosave: (_key: string, _enabled: boolean, save: () => Promise<void>) => { saveDraft = save; return { hydrate: () => {}, flush: save }; },
  useRegisterSaveDraft: () => {}, STATUS_KEY: () => ["status"],
  api: { post: async (url: string, payload: Record<string, unknown>) => { requests.push({ url, payload }); } },
  DailyWorkView: daily.DailyWorkView, dailyWorkShowsResults: daily.dailyWorkShowsResults,
  visibleDailyWorkRows: daily.visibleDailyWorkRows, combineAppointmentRows: daily.combineAppointmentRows,
  rowTaskType: daily.rowTaskType,
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
  Table: tag("table"), TableHeader: tag("thead"), TableBody: tag("tbody"), TableRow: tag("tr"), TableHead: tag("th"), TableCell: tag("td"),
  Input: (p: React.InputHTMLAttributes<HTMLInputElement>) => { inputProps.push(p); return <input {...p} />; },
  NativeSelect: (p: { onChange: (e: { target: { value: string } }) => void }) => { selectProps.push(p); return <select />; },
  SearchableDropdown: (p: { onChange: (value: string) => void }) => { dropdown = p; return <div data-testid="market-dropdown" />; },
  Button: (p: { children?: React.ReactNode }) => { buttons.push(p); return <button>{p.children}</button>; },
  Plus: () => null, Trash2: () => null, Skeleton: () => null, AppointedPopup: () => <div data-testid="monthly-popup" />,
});
const Section = mod.exports.AppointmentSection;
function render(view = "PLAN", locked = false) {
  renderCursor = 0; effects = []; inputProps.length = 0; selectProps.length = 0; buttons.length = 0; dropdown = undefined;
  return renderToStaticMarkup(<Section workDate="2026-10-15" view={view} locked={locked} />);
}
function reset(on: boolean, row?: Partial<Row>) {
  enabled = on;
  states = [[{ ...mod.exports.newApptRow(on), ...row }], null, null]; requests.length = 0;
}
async function main() {
  for (const on of [false, true]) {
    reset(on); states[0] = [];
    render(); effects[0](); // Real hydration with an empty server response.
    render();
    assert.equal((states[0] as Row[]).length, 0, "loading an empty plan never creates a row");
    assert.equal(inputProps.length, 0); assert.equal(dropdown, undefined);
    buttons.at(-1)!.onClick!(); render();
    assert.equal((states[0] as Row[]).length, 1, "Add explicitly creates a row");
    await saveDraft();
    assert.equal((requests[0].payload.rows as unknown[]).length, 1, "incomplete drafts are preserved for submit validation");
    buttons[0].onClick!(); render();
    assert.equal((states[0] as Row[]).length, 0, "deleting the last row leaves the plan empty");
    await saveDraft();
    assert.equal((requests[1].payload.rows as unknown[]).length, 0);
    render("REPORT"); assert.equal(selectProps.length, 0, "empty report has no result to fill");
  }
  reset(false);
  let html = render();
  assert.ok(html.includes('placeholder="Dealer name"') && html.includes('placeholder="Market"'));
  assert.equal(dropdown, undefined, "OFF does not render the monthly market selector");
  assert.equal(inputProps.every((p) => !p.disabled), true);
  inputProps[0].onChange!({ target: { value: "Typed Dealer" } } as React.ChangeEvent<HTMLInputElement>);
  inputProps[1].onChange!({ target: { value: "Typed Market" } } as React.ChangeEvent<HTMLInputElement>);
  render(); await saveDraft();
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].payload.rows)), [{ rowId: (states[0] as Row[])[0].rowId, dealerName: "Typed Dealer", marketName: "Typed Market" }]);
  assert.equal(requests[0].payload.partyPlanningEnabled, false);
  buttons.at(-1)!.onClick!(); assert.equal((states[0] as Row[]).length, 2, "OFF Add Dealer works without approved markets");

  reset(true);
  html = render(); assert.ok(html.includes('data-testid="market-dropdown"')); assert.equal(inputProps.length, 0);
  dropdown!.onChange("p1"); render(); await saveDraft();
  assert.equal((requests[0].payload.rows as { monthlyPlanId: string }[])[0].monthlyPlanId, "p1");
  assert.equal(requests[0].payload.partyPlanningEnabled, true);

  reset(false, { dealerName: "Saved Dealer", marketName: "Saved Market", rowStatus: "PLAN_SUBMITTED" });
  render("REPORT"); selectProps[0].onChange({ target: { value: "APPOINTED" } });
  html = render("REPORT"); assert.ok(!html.includes("monthly-popup")); await saveDraft();
  assert.equal((requests[0].payload.entries as { status: string }[])[0].status, "APPOINTED");
  assert.equal(inputProps.every((p) => p.disabled), true, "manual submitted names stay read-only");

  reset(true, { monthlyPlanId: "p1", marketName: "Karuaa", legacy: false, rowStatus: "PLAN_SUBMITTED" });
  render("REPORT"); selectProps[0].onChange({ target: { value: "APPOINTED" } });
  html = render("REPORT"); assert.ok(html.includes("monthly-popup"));
  assert.equal((states[0] as Row[])[0].status, "", "linked result is not committed before popup save");

  reset(true, { dealerName: "Historic Manual", marketName: "Original Market", legacy: true, rowStatus: "PLAN_SUBMITTED" });
  html = render("REPORT"); assert.ok(html.includes("Historic Manual"));
  selectProps[0].onChange({ target: { value: "APPOINTED" } }); html = render("REPORT");
  assert.ok(!html.includes("monthly-popup"), "enabling the feature never converts historical manual rows");
  reset(false); render("PLAN", true); assert.equal(inputProps.every((p) => p.disabled), true); assert.equal(buttons.every((p) => p.disabled), true);
  console.log("appointment-switch-ui.test.tsx — both tables, typed/selected save payloads, report popups and history passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
