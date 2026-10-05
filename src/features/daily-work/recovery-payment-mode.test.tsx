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

async function main() {
  let html = render("RECOVERY");
  const heads = [...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((match) =>
    match[1]
      .replace(/<[^>]*>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ")
      .trim(),
  );
  assert.deepEqual(heads, [
    "Dealer",
    "Task Type",
    "Monthly Recovery Plan",
    "Pending",
    "Today's Plan",
    "Payment Mode",
    "Recovery Type",
    "",
  ]);
  assert.ok(
    html.includes('Monthly<br/><span class="whitespace-nowrap">Recovery Plan</span>'),
    "default header breaks after Monthly",
  );
  const cells = [...html.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map(
    (row) => [...row[1].matchAll(/<t[hd]\b/g)].length,
  );
  assert.deepEqual(cells, [8, 8, 8], "header, summary and dealer row have identical column grids");
  const paymentSelect = selects.find((select) => select["aria-label"] === "Payment Mode")!;
  assert.deepEqual(
    Array.from(paymentSelect.options, (option) => option.value),
    [...RECOVERY_PAYMENT_MODES],
  );
  assert.deepEqual(
    Array.from(paymentSelect.options, (option) => option.label),
    ["Cheque", "UPI", "NEFT/RTGS", "Cash"],
  );
  assert.ok(
    html.includes('<option value="" selected="">Select...</option>'),
    "unselected rows stay blank",
  );
  assert.match(
    render("RECOVERY", "PLAN", true),
    /<select[^>]*aria-label="Payment Mode"[^>]*disabled=""/,
    "finalized days do not allow editing Payment Mode",
  );
  const blankKey = draftKey;
  paymentSelect.onChange!({ target: { value: "NEFT_RTGS" } });
  html = render("RECOVERY");
  assert.notEqual(draftKey, blankKey, "changing mode triggers the existing autosave dirty key");
  assert.ok(html.includes('<option value="NEFT_RTGS" selected="">NEFT/RTGS</option>'));
  await saveDraft();
  assert.deepEqual(requests.pop(), {
    url: "/api/daily-work/save",
    payload: {
      section: "RECOVERY",
      workDate: "2026-10-05",
      rows: [
        {
          dealerId: "dealer-1",
          todaysPlan: 500,
          entryType: "REGULAR",
          schemeId: null,
          paymentMode: "NEFT_RTGS",
        },
      ],
    },
  });

  html = render("SALES");
  assert.ok(
    !html.includes("Payment Mode") && !html.includes("NEFT/RTGS"),
    "Sales renders no Payment Mode",
  );
  await saveDraft();
  const salesRequest = requests.pop() as { payload: { rows: Record<string, unknown>[] } };
  assert.ok(!("paymentMode" in salesRequest.payload.rows[0]), "Sales payload stays unchanged");

  rows[0].status = "PLAN_SUBMITTED";
  html = render("RECOVERY", "REPORT");
  assert.ok(
    html.includes('title="Payment Mode">NEFT/RTGS</span>'),
    "frozen report displays saved mode read-only",
  );
  assert.ok(!html.includes('aria-label="Payment Mode"'), "report cannot edit plan metadata");
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
  rows[0].paymentMode = null;
  html = render("RECOVERY", "REPORT");
  assert.ok(html.includes('title="Payment Mode">—</span>'), "legacy report metadata remains empty");
  assert.equal(labelMeta("daily_work.col.payment_mode").module, "Daily Work");
  console.log("recovery-payment-mode.test.tsx — all assertions passed");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
