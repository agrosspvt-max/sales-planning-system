/** Retailer Mapping — pure rules shared by the form and the server (one definition, so what the form accepts is exactly what the server accepts). */
export const PHONE_RE = /^[0-9]{10}$/;
export const RETAILER_NAME_MAX = 120;
export const MAX_LINKED_DEALERS = 200;
export type RetailerInputError = "name_required" | "name_long" | "firm_required" | "firm_long" | "phone_invalid" | "dealers_required" | "dealers_too_many";
export const cleanText = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
/** Exactly ten ASCII digits; nothing is stripped or normalized (no signs, spaces, decimals or country codes are tolerated). */
export const isValidPhone = (v: unknown): v is string => typeof v === "string" && PHONE_RE.test(v);

export interface RetailerInput { retailerName: string; firmName: string; phone: string; dealerIds: string[] }
/** First problem of a submission, or null. `dealerIds` are de-duplicated by the caller (a dealer can be selected only once). */
export function validateRetailerInput(i: { retailerName: unknown; firmName: unknown; phone: unknown; dealerIds: unknown }): RetailerInputError | null {
  const name = cleanText(i.retailerName), firm = cleanText(i.firmName);
  if (!name) return "name_required";
  if (name.length > RETAILER_NAME_MAX) return "name_long";
  if (!firm) return "firm_required";
  if (firm.length > RETAILER_NAME_MAX) return "firm_long";
  if (!isValidPhone(i.phone)) return "phone_invalid";
  const ids = Array.isArray(i.dealerIds) ? i.dealerIds : [];
  if (ids.length === 0) return "dealers_required";
  if (ids.length > MAX_LINKED_DEALERS) return "dealers_too_many";
  return null;
}
