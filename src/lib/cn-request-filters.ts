import { canonicalCnType, cnRequestCurrentDisplayStatus, paymentStatusLabel } from "./cn-request";

export const CN_FILTER_KEYS = ["party", "cnType", "amount", "paymentStatus", "employee", "state", "territory", "status", "days", "expiry"] as const;
export type CnFilterKey = (typeof CN_FILTER_KEYS)[number];
export type CnFilters = Partial<Record<CnFilterKey, string[]>>;
export interface CnFilterRow {
  dealerId: string; cnType: string; amount: number | null; paymentStatus: string | null;
  officerId: string; state: string | null; territory: string | null; status: string; days: number | null; expiryDate: string | null;
}

/** Stable values shared by table filters and the existing admin export; names/translated labels never identify employees or dealers. */
export function cnFilterValue(row: CnFilterRow, key: CnFilterKey): string {
  switch (key) {
    case "party": return row.dealerId;
    case "cnType": return canonicalCnType(row.cnType);
    case "amount": return row.amount == null ? "" : String(Math.round(row.amount)); // matches the table's whole-rupee display
    case "paymentStatus": return row.paymentStatus ? paymentStatusLabel(row.paymentStatus) : "";
    case "employee": return row.officerId;
    case "state": return row.state ?? "";
    case "territory": return row.territory ?? "";
    case "status": return cnRequestCurrentDisplayStatus(row.status, row.paymentStatus);
    case "days": return row.days == null ? "" : String(row.days);
    case "expiry": return row.expiryDate ?? "";
  }
}

/** OR within a column, AND across columns. Input must already be authorized and scoped to the current tab. */
export function filterCnRequests<T extends CnFilterRow>(rows: readonly T[], filters: CnFilters): T[] {
  return rows.filter((row) => CN_FILTER_KEYS.every((key) => !filters[key]?.length || filters[key]!.includes(cnFilterValue(row, key))));
}

export function cnFilterParams(filters: CnFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of CN_FILTER_KEYS) for (const value of new Set(filters[key] ?? [])) params.append(key, value);
  return params;
}

export function parseCnFilters(params: URLSearchParams): CnFilters {
  return Object.fromEntries(CN_FILTER_KEYS.map((key) => [key, [...new Set(params.getAll(key))]]));
}
