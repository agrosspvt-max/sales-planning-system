import type * as XLSX from "xlsx";
import { achievement } from "@/lib/calc";
import type { DealerFinancialRow } from "./dealer-financial-summary-table";
import type { GroupProductRow } from "./group-plan.server";

type Format = "quantity" | "currency" | "percent";
interface PlanColumn<Row> {
  key: string;
  label: string;
  format: Format;
  value: (row: Row) => number;
}

type ProductFigures = Pick<GroupProductRow,
  "seasonQty" | "plannedAllMonths" | "remaining" | "seasonSales" | "pendingSales" |
  "seasonAmount" | "plannedAllMonthsAmount" | "remainingAmount" | "seasonSalesAmount" |
  "pendingAmount" | "total" | "actual">;

interface ProductColumn extends PlanColumn<ProductFigures> {
  title: string;
  sectionStart?: boolean;
  comparison?: boolean;
  muted?: boolean;
  optionalAmount?: boolean;
}

const productPlanColumns: ProductColumn[] = [
  { key: "seasonQty", label: "Season Qty", title: "Total seasonal quantity planned", format: "quantity", value: (r) => r.seasonQty, sectionStart: true },
  { key: "seasonAmount", label: "Season Amt", title: "Amount for Season Qty", format: "currency", value: (r) => r.seasonAmount, optionalAmount: true },
  { key: "plannedAllMonths", label: "Planned (All Mo.)", title: "Quantity distributed into monthly plans across all months", format: "quantity", value: (r) => r.plannedAllMonths },
  { key: "plannedAllMonthsAmount", label: "Planned Amt", title: "Amount for Planned (All Months)", format: "currency", value: (r) => r.plannedAllMonthsAmount, optionalAmount: true },
  { key: "remaining", label: "Remaining", title: "Planned (All Months) − Season Qty", format: "quantity", value: (r) => r.remaining, comparison: true },
  { key: "remainingAmount", label: "Remaining Amt", title: "Planned Amount − Season Amount", format: "currency", value: (r) => r.remainingAmount, optionalAmount: true, comparison: true },
  { key: "seasonSales", label: "Season Sales", title: "Actual sales quantity for the complete season", format: "quantity", value: (r) => r.seasonSales },
  { key: "seasonSalesAmount", label: "Sales Amt", title: "Amount for Season Sales", format: "currency", value: (r) => r.seasonSalesAmount, optionalAmount: true },
  { key: "pendingSales", label: "Pending", title: "Season Sales − Season Qty", format: "quantity", value: (r) => r.pendingSales, comparison: true },
  { key: "pendingAmount", label: "Pending Amt", title: "Sales Amount − Season Amount", format: "currency", value: (r) => r.pendingAmount, optionalAmount: true, comparison: true },
  { key: "periodPlan", label: "Period Plan", title: "Plan for the selected period", format: "quantity", value: (r) => r.total.qty, sectionStart: true },
  { key: "periodSold", label: "Period Sold", title: "Sold in the selected period", format: "quantity", value: (r) => r.actual.qty },
  { key: "planAmount", label: "Plan Amt", title: "Planned Amount for the selected period", format: "currency", value: (r) => r.total.amount, sectionStart: true },
  { key: "planNbv", label: "Plan NBV", title: "Planned NBV for the selected period", format: "currency", value: (r) => r.total.nbv },
  { key: "actualAmount", label: "Act. Amt", title: "Actual Amount for the selected period", format: "currency", value: (r) => r.actual.amount, muted: true },
  { key: "actualNbv", label: "Act. NBV", title: "Actual NBV for the selected period", format: "currency", value: (r) => r.actual.nbv, muted: true },
];

export function getProductPlanColumns(showAmounts: boolean) {
  return productPlanColumns.filter((column) => showAmounts || !column.optionalAmount);
}

export function productColumnTotals(rows: readonly ProductFigures[], columns: readonly ProductColumn[]) {
  return columns.map((column) => rows.reduce((total, row) => total + column.value(row), 0));
}

export const dealerPlanColumns: PlanColumn<Pick<DealerFinancialRow, "planAmount" | "planNbv" | "actualAmount" | "actualNbv">>[] = [
  { key: "planAmount", label: "Monthly Plan", format: "currency", value: (r) => r.planAmount },
  { key: "planNbv", label: "Planned NBV", format: "currency", value: (r) => r.planNbv },
  { key: "actualAmount", label: "Actual Sales", format: "currency", value: (r) => r.actualAmount },
  { key: "actualNbv", label: "Actual NBV", format: "currency", value: (r) => r.actualNbv },
  { key: "salesAchievement", label: "Sales Achv %", format: "percent", value: (r) => achievement(r.actualAmount, r.planAmount) },
  { key: "nbvAchievement", label: "NBV Achv %", format: "percent", value: (r) => achievement(r.actualNbv, r.planNbv) },
];

export function dealerFinancialTotals(rows: readonly DealerFinancialRow[]) {
  return rows.reduce(
    (total, row) => ({
      planAmount: total.planAmount + row.planAmount,
      planNbv: total.planNbv + row.planNbv,
      actualAmount: total.actualAmount + row.actualAmount,
      actualNbv: total.actualNbv + row.actualNbv,
    }),
    { planAmount: 0, planNbv: 0, actualAmount: 0, actualNbv: 0 },
  );
}

const formats: Record<Format, string> = {
  quantity: "#,##0.######",
  currency: '"₹"#,##0.00',
  percent: "0.0%",
};

interface ExportContext {
  group: string;
  season: string;
  period: string;
  officer: string;
  plans: string;
  category: string;
}

type PlanExport = ExportContext & (
  | { view: "dealer"; rows: DealerFinancialRow[] }
  | { view: "product"; rows: (ProductFigures & { productName: string })[]; showAmounts: boolean; baseline: string }
);

export function buildGroupPlanWorkbook(xlsx: typeof XLSX, options: PlanExport) {
  const title = options.view === "dealer" ? "Territory Plan" : "Product Plan";
  const firstColumn = options.view === "dealer" ? "Dealer" : "Product";
  const context = [
    [`${options.group} — ${title}`],
    ["Season", options.season],
    ["Period", options.period],
    ["Team Member", options.officer],
    ["Included Plans", options.plans],
    ["Category", options.category],
  ];
  if (options.view === "product") context.push(["Season Baseline", options.baseline]);

  function writeWorkbook(
    columns: readonly { label: string; format: Format }[],
    rows: (string | number)[][],
    totals: number[],
  ) {
    const headerIndex = context.length + 1;
    const cells = [...context, [], [firstColumn, ...columns.map((column) => column.label)], ...rows, ["Total", ...totals]];
    const sheet = xlsx.utils.aoa_to_sheet(cells);
    for (let rowIndex = headerIndex + 1; rowIndex < cells.length; rowIndex++) {
      columns.forEach((column, index) => {
        sheet[xlsx.utils.encode_cell({ r: rowIndex, c: index + 1 })].z = formats[column.format];
      });
    }
    sheet["!cols"] = [
      { wch: options.view === "dealer" ? 65 : 36 },
      ...columns.map((column) => ({ wch: Math.max(column.label.length + 2, 19) })),
    ];
    if (rows.length) {
      sheet["!autofilter"] = {
        ref: xlsx.utils.encode_range({ s: { r: headerIndex, c: 0 }, e: { r: headerIndex + rows.length, c: columns.length } }),
      };
    }
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, sheet, title);
    const fileName = [title, options.group, options.season, options.period].join(" - ").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
    return { workbook, fileName: `${fileName}.xlsx` };
  }

  if (options.view === "dealer") {
    const totals = dealerFinancialTotals(options.rows);
    return writeWorkbook(dealerPlanColumns,
      options.rows.map((row) => [row.name, ...dealerPlanColumns.map((column) => column.value(row))]),
      dealerPlanColumns.map((column) => column.value(totals)));
  }

  const columns = getProductPlanColumns(options.showAmounts);
  return writeWorkbook(columns,
    options.rows.map((row) => [row.productName, ...columns.map((column) => column.value(row))]),
    productColumnTotals(options.rows, columns));
}

export async function downloadGroupPlan(options: PlanExport) {
  const xlsx = await import("xlsx");
  const { workbook, fileName } = buildGroupPlanWorkbook(xlsx, options);
  xlsx.writeFile(workbook, fileName);
}
