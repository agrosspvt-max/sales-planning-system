/** Shared Seasonal Plan export fixture (tests + LibreOffice recalculation): every planning mode, per-dealer saved prices, a merged product, NBV % 0,
 * negative actual sales, a closed-month section, and Completed / No Plan / Remaining dealers. */
import type { PlanningMode } from "@/lib/calc";
import type { ExportDealer, SeasonalExportModel } from "./seasonal-plan-workbook";

export function fixture(mode: PlanningMode, opts: { dealers?: number; names?: string[] } = {}): SeasonalExportModel {
  const packs = mode === "PACK_SIZE" ? [{ id: "pk1", name: "1 LTR" }, { id: "pk5", name: "500 ML" }, { id: "pk2", name: "250 ML" }] : [];
  const products = [
    { productId: "p-tandab", name: "TANDAB", technicalName: "NOVALURON", effectiveId: "p-tandab", effectiveName: "TANDAB", effectiveTechnicalName: "NOVALURON" },
    { productId: "p-taandab", name: "TAANDAB", technicalName: "NOVALURON (old)", effectiveId: "p-tandab", effectiveName: "TANDAB", effectiveTechnicalName: "NOVALURON" }, // merged source
    { productId: "p-agora", name: "AGORA", technicalName: "BIFENTHRIN", effectiveId: "p-agora", effectiveName: "AGORA", effectiveTechnicalName: "BIFENTHRIN" },
    { productId: "p-zero", name: "ZERO NBV", technicalName: null, effectiveId: "p-zero", effectiveName: "ZERO NBV", effectiveTechnicalName: null },
  ].sort((a, b) => a.name.localeCompare(b.name));
  const months = [{ key: "m6", label: "June 2026" }, { key: "m7", label: "July 2026" }, { key: "CLOSED", label: "Closed months (combined)" }];
  const names = opts.names ?? Array.from({ length: opts.dealers ?? 3 }, (_, i) => `Dealer ${String(i).padStart(3, "0")}`);
  const dealers: ExportDealer[] = names.map((name, i) => {
    const status = i === 1 ? "NO_PLAN" as const : i === 2 ? "REMAINING" as const : "COMPLETED" as const;
    const planned = status === "COMPLETED";
    const v = (n: number) => (planned ? n : 0);
    return {
      dealerId: `d${i}`, name, status, noPlanReason: status === "NO_PLAN" ? "Dealer closed for the season" : null,
      lines: {
        // Saved planning price differs per dealer and from the price list (rateSnapshot), as on real plans.
        "p-tandab": { rate: 1970.15 + i, nbvPercent: 0.25, packs: { pk1: v(4), pk5: v(2) }, value: v(10 + i), months: { m6: { planQty: v(3), saleQty: 2, saleAmount: 3900.5 }, CLOSED: { planQty: 1, saleQty: 1, saleAmount: -150 } } },
        "p-taandab": { rate: 1800, nbvPercent: 0.2, packs: { pk2: v(1) }, value: v(2), months: {} },
        "p-agora": { rate: 514.15, nbvPercent: 0.255, packs: {}, value: 0, months: { m7: { planQty: 0, saleQty: 0, saleAmount: -42.25 } } }, // a return: negative actual amount
        "p-zero": { rate: 100, nbvPercent: 0, packs: { pk1: v(5) }, value: v(500), months: {} }, // NBV % 0
      },
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return {
    officerName: "Chhitranjan", stateName: "WB", seasonLabel: "Kharif 2026", planLabel: "Version 2 · Approved", modeLabel: mode, mode, packs, months,
    catalogue: [
      { productId: "p-agora", name: "AGORA", technicalName: "BIFENTHRIN", rate: 514.15, nbvPercent: 0.255 },
      { productId: "p-tandab", name: "TANDAB", technicalName: "NOVALURON", rate: 2000, nbvPercent: 0.25 },
      { productId: "p-zero", name: "ZERO NBV", technicalName: null, rate: 100, nbvPercent: 0 },
    ],
    catalogueSourceLabel: "WB state catalogue", products, dealers,
  };
}

