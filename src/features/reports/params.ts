import type { ReportFilters, ReportSort, ReportType } from "./types";

const TYPES: ReportType[] = [
  "product",
  "brand",
  "category",
  "dealer",
  "officer",
  "regional",
  "company",
  "season",
  "monthly",
];

export function parseReportParams(sp: URLSearchParams): {
  seasonId: string;
  type: ReportType;
  filters: ReportFilters;
  sort?: ReportSort;
} {
  const typeParam = (sp.get("type") ?? "product") as ReportType;
  const type = TYPES.includes(typeParam) ? typeParam : "product";
  const sortKey = sp.get("sortKey");
  const sort: ReportSort | undefined = sortKey
    ? { key: sortKey, dir: sp.get("sortDir") === "asc" ? "asc" : "desc" }
    : undefined;
  const filters: ReportFilters = {
    manager: sp.get("manager") ?? undefined,
    officer: sp.get("officer") ?? undefined,
    dealer: sp.get("dealer") ?? undefined,
    brand: sp.get("brand") ?? undefined,
    category: sp.get("category") ?? undefined,
  };
  return { seasonId: sp.get("season") ?? "", type, filters, sort };
}
