/** Render the existing Recovery tables and exercise their real row/payload wiring without a database. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { DEFAULT_LABELS, labelMeta, type LabelKey } from "@/features/labels/labels";
import { RECOVERY_PAYMENT_MODES, type RecoveryPaymentMode } from "@/lib/daily-work";
import { testLoader } from "@/features/dealer-tags/test-loader";

let rows = [
  {
    entryId: "entry-1",
    batchId: "batch-1",
    dealerId: "dealer-1",
    dealerName: "Test Dealer",
    monthlyPlan: 1000,
    actual: 100,
    pending: 900,
    todaysPlan: "500",
    todaysActual: "",
    entryType: "REGULAR",
    schemeId: "",
    paymentMode: null as RecoveryPaymentMode | null,
    status: "DRAFT",
  },
];
const requests: unknown[] = [];
let saveDraft: () => Promise<unknown>;
let draftKey = "";
const selects: Array<{
  options: { value: string; label: string }[];
  onChange?: (event: { target: { value: string } }) => void;
  "aria-label"?: string;
}> = [];
const requireLocal = createRequire(import.meta.url);
const useLabel = (key: LabelKey) => DEFAULT_LABELS[key];
const overrides: Record<string, unknown> = {
  react: {
    ...React,
    useState: (initial: unknown) => [
      Array.isArray(initial) ? rows : initial,
      (update: unknown) => {
        if (typeof update === "function")
          rows = (update as (value: typeof rows) => typeof rows)(rows);
      },
    ],
  },
  "@/features/labels/label-ui": { useLabel },
  "@/features/dealers/dealer-name-ui": {
    DealerName: ({ name }: { name: string }) => <>{name}</>,
    useDealerMarkers: () => ({}),
  },
  "@/features/dealers/dealer-table-ui": {
    DealerTableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
    DealerOrder: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  },
  "@tanstack/react-query": {
    useQuery: () => ({
      isLoading: false,
      data: {
        dealers: [],
        applicableSchemes: [],
        applicableSchemesByDealer: {},
        availableDealers: [],
      },
    }),
    useQueryClient: () => ({ invalidateQueries: () => {} }),
    useMutation: () => ({ isPending: false, mutate: () => {} }),
  },
  "@/lib/api-client": {
    api: {
      post: async (url: string, payload: unknown) => {
        requests.push(JSON.parse(JSON.stringify({ url, payload })));
      },
    },
  },
  "./use-daily-autosave": {
    useDailyAutosave: (key: string, _enabled: boolean, save: () => Promise<unknown>) => {
      draftKey = key;
      saveDraft = save;
      return { hydrate: () => {}, flush: save, saving: false, failed: false, savedAt: null };
    },
  },
  "@/components/ui/input": {
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => {
      inputs.push(props as (typeof inputs)[number]);
      return <input {...props} />;
    },
  },
  "@/components/ui/select": {
    NativeSelect: (
      props: React.SelectHTMLAttributes<HTMLSelectElement> & {
        options: { value: string; label: string }[];
        placeholder?: string;
      },
    ) => {
      selects.push(props as (typeof selects)[number]);
      const { options, placeholder, ...rest } = props;
      return (
        <select {...rest}>
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    },
  },
};
const load = testLoader(overrides);

// Export private presentation functions in memory only; the production files retain their existing exports.
function loadPresentation<T>(path: string, names: string[]): T {
  const filename = resolve(path);
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  runInNewContext(code + names.map((name) => `\nexports.${name} = ${name};`).join(""), {
    module: mod,
    exports: mod.exports,
    require: (name: string) => {
      if (name in overrides) return overrides[name];
      if (name.startsWith("@/") || name.startsWith("./")) {
        const base = name.startsWith("@/")
          ? `src/${name.slice(2)}`
          : `src/features/daily-work/${name.slice(2)}`;
        return load(existsSync(`${base}.ts`) ? `${base}.ts` : `${base}.tsx`);
      }
      return requireLocal(name);
    },
  });
  return mod.exports as T;
}

const { DailyWorkSection } = loadPresentation<{
  DailyWorkSection: React.ComponentType<{
    section: "SALES" | "RECOVERY";
    workDate: string;
    view: "PLAN" | "REPORT";
    locked: boolean;
  }>;
}>("src/features/daily-work/daily-work-page.tsx", ["DailyWorkSection"]);
const { AdminDealerReport } = loadPresentation<{
  AdminDealerReport: React.ComponentType<{ section: "SALES" | "RECOVERY"; data: unknown }>;
}>("src/features/daily-work/admin-daily-work-viewer.tsx", ["AdminDealerReport"]);
const { DealerSection } = loadPresentation<{
  DealerSection: React.ComponentType<{ title: string; rows: unknown[]; recovery?: boolean }>;
}>("src/features/daily-work/team-performance-page.tsx", ["DealerSection"]);
const render = (
  section: "SALES" | "RECOVERY",
  view: "PLAN" | "REPORT" = "PLAN",
  locked = view === "REPORT",
) =>
  renderToStaticMarkup(
    <DailyWorkSection section={section} workDate="2026-10-05" view={view} locked={locked} />,
  );

const inputs: Array<{ value?: string; disabled?: boolean; onChange?: (event: { target: { value: string } }) => void }> = [];
const paymentSelects = () => selects.filter((select) => select["aria-label"] === "Payment Mode");
const headings = (html: string) => [...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((match) =>
  match[1].replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim());
const paymentHtml = (html: string) => html.match(/<select[^>]*aria-label="Payment Mode"[^>]*>/)?.[0] ?? "";
const reportRow = (todaysActual: string, paymentMode: RecoveryPaymentMode | null = null) => {
  rows = [{ ...rows[0], status: "PLAN_SUBMITTED", todaysActual, paymentMode }];
};
const actualInput = () => inputs[inputs.length - 1]!;

async function main() {
  // ---- Daily PLAN: no Payment Mode anywhere (column, control, payload) ----
  let html = render("RECOVERY");
  assert.deepEqual(headings(html), ["Dealer", "Task Type", "Monthly Recovery Plan", "Pending", "Today's Plan", "Recovery Type", ""]);
  assert.ok(html.includes('Monthly<br/><span class="whitespace-nowrap">Recovery Plan</span>'), "default header breaks after Monthly");
  const cells = [...html.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map((row) => [...row[1].matchAll(/<t[hd]\b/g)].length);
  assert.deepEqual(cells, [7, 7, 7], "header, summary and dealer row share one grid with no empty Payment Mode column");
  assert.equal(paymentSelects().length, 0, "Plan renders no Payment Mode control");
  assert.ok(!html.includes("Payment Mode"), "Plan shows no Payment Mode text");
  rows[0].paymentMode = "CASH"; // a legacy value in state is never displayed or sent from the Plan
  await saveDraft();
  assert.deepEqual(requests.pop(), {
    url: "/api/daily-work/save",
    payload: { section: "RECOVERY", workDate: "2026-10-05", rows: [{ dealerId: "dealer-1", todaysPlan: 500, entryType: "REGULAR", schemeId: null }] },
  }, "Plan save keeps working and carries no Payment Mode");
  rows[0].paymentMode = null;
  html = render("SALES");
  assert.ok(!html.includes("Payment Mode") && !html.includes("NEFT/RTGS"), "Sales renders no Payment Mode");
  await saveDraft();
  assert.ok(!("paymentMode" in (requests.pop() as { payload: { rows: Record<string, unknown>[] } }).payload.rows[0]));

  // ---- Daily REPORT: Payment Mode next to Today's Recovery, driven by the numeric amount ----
  selects.length = 0; inputs.length = 0;
  reportRow("", null);
  html = render("RECOVERY", "REPORT", false);
  assert.deepEqual(headings(html), ["Dealer", "Monthly Recovery Plan", "Pending", "Today's Plan", "Recovery Type", "Today's Recovery", "Payment Mode"]);
  assert.deepEqual(Array.from(paymentSelects()[0].options, (o) => o.value), [...RECOVERY_PAYMENT_MODES]);
  assert.deepEqual(Array.from(paymentSelects()[0].options, (o) => o.label), ["Cheque", "UPI", "NEFT/RTGS", "Cash"]);
  const reportCells = [...html.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map((row) => [...row[1].matchAll(/<t[hd]\b/g)].length);
  assert.deepEqual(reportCells, [7, 7, 7]);
  assert.ok(html.indexOf("Today&#x27;s Recovery") < html.indexOf("Payment Mode"), "Payment Mode sits after Today's Recovery");
  for (const [amount, enabled] of [["", false], ["0", false], ["-5", false], ["0.5", true], ["25000", true]] as const) {
    selects.length = 0; reportRow(amount, "UPI");
    html = render("RECOVERY", "REPORT", false);
    assert.equal(/disabled=""/.test(paymentHtml(html)), !enabled, `recovery ${JSON.stringify(amount)} -> Payment Mode ${enabled ? "enabled" : "disabled"}`);
    assert.equal(html.includes('<option value="UPI" selected="">UPI</option>'), enabled, "a stale mode is never shown against a non-positive recovery");
  }

  // Selecting each mode persists through the Report autosave call (the existing /actual endpoint) with the amount.
  for (const mode of RECOVERY_PAYMENT_MODES) {
    selects.length = 0; reportRow("20000", null);
    render("RECOVERY", "REPORT", false);
    paymentSelects()[0].onChange!({ target: { value: mode } });
    html = render("RECOVERY", "REPORT", false);
    assert.ok(html.includes(`<option value="${mode}" selected="">`), `${mode} selected`);
    assert.ok(draftKey.includes(`"paymentMode":"${mode}"`), "the autosave dirty key changes with the mode");
    await saveDraft();
    assert.deepEqual(requests.pop(), { url: "/api/daily-work/actual", payload: { section: "RECOVERY", workDate: "2026-10-05", entries: [{ entryId: "entry-1", todaysActual: 20000, paymentMode: mode }] } });
  }
  // UPI -> Cash change persists the new value.
  selects.length = 0; reportRow("20000", "UPI");
  render("RECOVERY", "REPORT", false);
  paymentSelects()[0].onChange!({ target: { value: "CASH" } });
  render("RECOVERY", "REPORT", false);
  await saveDraft();
  assert.equal((requests.pop() as { payload: { entries: { paymentMode: string }[] } }).payload.entries[0].paymentMode, "CASH");

  // Changing the amount to 0 or negative CLEARS the mode (state + payload); positive again starts blank.
  for (const cleared of ["0", "-3"]) {
    selects.length = 0; inputs.length = 0; reportRow("10000", "UPI");
    render("RECOVERY", "REPORT", false);
    actualInput().onChange!({ target: { value: cleared } });
    html = render("RECOVERY", "REPORT", false);
    assert.equal(rows[0].paymentMode, null, `recovery ${cleared} cleared the stored mode`);
    assert.ok(/disabled=""/.test(paymentHtml(html)), "and disabled the control");
    await saveDraft();
    assert.equal((requests.pop() as { payload: { entries: { paymentMode: unknown }[] } }).payload.entries[0].paymentMode, null, "cleared mode is persisted as null");
    actualInput().onChange!({ target: { value: "5000" } });
    html = render("RECOVERY", "REPORT", false);
    assert.ok(!/disabled=""/.test(paymentHtml(html)), "positive again re-enables it");
    assert.equal(rows[0].paymentMode, null, "…starting blank (never guessed)");
  }

  // Finalized day: the control stays visible but read-only like every other Report field.
  reportRow("10000", "NEFT_RTGS");
  html = render("RECOVERY", "REPORT", true);
  assert.ok(/disabled=""/.test(paymentHtml(html)) && html.includes('<option value="NEFT_RTGS" selected="">NEFT/RTGS</option>'), "finalized Payment Mode is locked");

  rows[0].paymentMode = "NEFT_RTGS";
  const data = {
    dealers: [{ ...rows[0], todaysPlan: 500, todaysActual: 100 }],
    autoTaskEntryIds: [],
  };
  html = renderToStaticMarkup(<AdminDealerReport section="RECOVERY" data={data} />);
  assert.ok(
    html.includes("Payment Mode") && html.includes("NEFT/RTGS"),
    "Admin Recovery includes persisted mode",
  );
  assert.ok(
    html.indexOf("Today&#x27;s Plan") < html.indexOf("Payment Mode") &&
      html.indexOf("Payment Mode") < html.indexOf("Recovery Type"),
  );
  assert.ok(
    !renderToStaticMarkup(<AdminDealerReport section="SALES" data={data} />).includes(
      "Payment Mode",
    ),
  );
  assert.ok(
    renderToStaticMarkup(<DealerSection title="Recovery" rows={data.dealers} recovery />).includes(
      'title="Payment Mode">NEFT/RTGS',
    ),
  );
  assert.ok(
    !renderToStaticMarkup(<DealerSection title="Sales" rows={data.dealers} />).includes(
      "Payment Mode",
    ),
  );
  assert.equal(labelMeta("daily_work.col.payment_mode").module, "Daily Work");
  console.log("recovery-payment-mode.test.tsx — all assertions passed");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
