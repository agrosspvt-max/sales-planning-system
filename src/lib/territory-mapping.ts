/**
 * Territory Mapping — shared, side-effect-free rules (Party Planning · Phase 1). Used by the server service and the browser UI,
 * and unit-tested directly. Nothing here touches the database.
 */

export const POTENTIALS = ["A", "B", "C"] as const;
export type Potential = (typeof POTENTIALS)[number];
export const isPotential = (value: unknown): value is Potential => typeof value === "string" && (POTENTIALS as readonly string[]).includes(value);

/** Normalized Market name used for duplicate detection: case, surrounding/repeated whitespace and punctuation never create a "new" market. */
export function marketNameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, " ").replace(/\s+/g, " ").trim();
}
/** Display form of a Market name: trimmed, inner whitespace collapsed (case preserved as entered). */
export const cleanMarketName = (name: string): string => name.replace(/\s+/g, " ").trim();

export const MARKET_NAME_MAX = 120;
export const MAX_PARTIES = 100000;

export const MARKET_REQUEST_STATUSES = ["PENDING_RM", "PENDING_ADMIN", "APPROVED", "REJECTED"] as const;
export type MarketRequestStatus = (typeof MARKET_REQUEST_STATUSES)[number];

/** Validation for the Add Market form (shared by the browser and the server). Returns an error message or null. */
export function validateMarketRequest(input: { marketName: unknown; potential: unknown; numberOfParties: unknown }): string | null {
  const name = typeof input.marketName === "string" ? cleanMarketName(input.marketName) : "";
  if (!name || !marketNameKey(name)) return "Market Name is required.";
  if (name.length > MARKET_NAME_MAX) return `Market Name can be at most ${MARKET_NAME_MAX} characters.`;
  if (!isPotential(input.potential)) return "Select a Market Potential (A, B or C).";
  const parties = typeof input.numberOfParties === "number" ? input.numberOfParties : typeof input.numberOfParties === "string" && input.numberOfParties.trim() !== "" ? Number(input.numberOfParties) : NaN;
  if (!Number.isInteger(parties) || parties < 1 || parties > MAX_PARTIES) return "No. of Parties must be a whole number greater than 0.";
  return null;
}

/* ------------------------------------- Excel import (Dealer | Market | District) ------------------------------------- */

export const DISTRICT_MAX = 120;
/** District is plain dealer territory text (no master): trimmed, inner whitespace collapsed, case preserved. */
export const cleanDistrict = (value: string): string => value.replace(/\s+/g, " ").trim();
/** Comparison key for a District ("Rajgarh" == " RAJGARH "). */
export const districtKey = (value: string): string => marketNameKey(value);

/** `district` is "" when the sheet has no District column or the cell is blank — meaning "leave the dealer's District unchanged". */
export interface ImportSheetRow { rowNumber: number; dealer: string; market: string; district: string }
export type ImportRowProblem = { rowNumber: number; dealer: string; market: string; district?: string; reason: string };

const cellText = (v: unknown): string => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());

/**
 * Read the selected sheet's rows (array-of-arrays, row 0 = header). The sheet must carry the columns `Dealer` and `Market`, and
 * may carry `District` (header text is case/space-insensitive; extra columns are ignored). An older Dealer | Market sheet still
 * works: District is then left unchanged. Returns the data rows plus the rows that are unusable on
 * their own (blank dealer or market). Fully blank rows are ignored.
 */
export function parseTerritorySheet(raw: readonly (readonly unknown[])[]): { error: string | null; rows: ImportSheetRow[]; invalid: ImportRowProblem[] } {
  const header = raw[0] ?? [];
  const find = (name: string) => header.findIndex((cell) => cellText(cell).toLowerCase() === name);
  const dealerCol = find("dealer"), marketCol = find("market"), districtCol = find("district");
  if (dealerCol < 0 || marketCol < 0) return { error: "The selected sheet must have two columns named Dealer and Market in its first row.", rows: [], invalid: [] };
  const rows: ImportSheetRow[] = [], invalid: ImportRowProblem[] = [];
  raw.slice(1).forEach((cells, index) => {
    const rowNumber = index + 2; // spreadsheet row number (header is row 1)
    const dealer = cellText(cells[dealerCol]), market = cellText(cells[marketCol]), district = districtCol < 0 ? "" : cellText(cells[districtCol]);
    if (!dealer && !market && !district) return;
    if (!dealer) return void invalid.push({ rowNumber, dealer, market, district, reason: "Dealer is empty" });
    if (!market || !marketNameKey(market)) return void invalid.push({ rowNumber, dealer, market, district, reason: "Market is empty" });
    if (market.length > MARKET_NAME_MAX) return void invalid.push({ rowNumber, dealer, market, district, reason: `Market is longer than ${MARKET_NAME_MAX} characters` });
    if (district.length > DISTRICT_MAX) return void invalid.push({ rowNumber, dealer, market, district, reason: `District is longer than ${DISTRICT_MAX} characters` });
    rows.push({ rowNumber, dealer, market, district });
  });
  return { error: null, rows, invalid };
}

export type ImportRowStatus = "MATCHED" | "UNMATCHED" | "AMBIGUOUS" | "INVALID" | "DUPLICATE" | "CONFLICT";
export interface ImportCandidate { dealerId: string; partyName: string; matchType: string; score: number }
export interface ImportPlanRow {
  rowNumber: number; excelDealer: string; excelMarket: string; excelDistrict: string; status: ImportRowStatus; reason?: string;
  dealerId?: string; partyName?: string; currentMarket?: string | null; currentDistrict?: string | null;
  marketName?: string; newMarket?: boolean;
  /** The District to store ("" = the sheet gave none, so the dealer's District is left alone). */
  districtName?: string;
  /** Overall result: MAP (no Market yet), CHANGE (Market and/or District differs), NO_CHANGE (everything already matches). */
  action?: "MAP" | "CHANGE" | "NO_CHANGE";
  /** What exactly will be written — the commit touches only these. */
  marketChanged?: boolean; districtChanged?: boolean;
  districtAction?: "ADD" | "CHANGE" | "NO_CHANGE" | "UNCHANGED";
  candidates?: ImportCandidate[];
}

/** What the dealer resolver said for one Excel name, already narrowed to what the caller may touch. */
export type ResolvedName =
  | { kind: "NONE" }
  | { kind: "SINGLE"; candidate: ImportCandidate; inScope: boolean }
  | { kind: "MANY"; candidates: ImportCandidate[]; anyInScope: boolean };

/** A name is matched automatically only when exactly ONE dealer is found by alias / exact / loose name. A fuzzy result is never auto-applied. */
export function classifyMatch(all: readonly (ImportCandidate & { inScope: boolean })[]): ResolvedName {
  if (all.length === 0) return { kind: "NONE" };
  const sure = all.every((c) => c.matchType !== "FUZZY");
  if (all.length === 1 && sure) return { kind: "SINGLE", candidate: all[0]!, inScope: all[0]!.inScope };
  const visible = all.filter((c) => c.inScope);
  return { kind: "MANY", candidates: visible.map(({ inScope: _inScope, ...c }) => c), anyInScope: visible.length > 0 };
}

/**
 * Turn the parsed rows + resolver output into the plan shown in the preview and applied on confirm. Pure: the caller supplies the
 * name lookup, the current mappings and the existing Markets. `resolutions` (rowNumber → dealerId) are the user's picks for
 * AMBIGUOUS rows and are honoured only when the picked dealer is one of that row's in-scope candidates.
 */
export function buildImportPlan(args: {
  rows: readonly ImportSheetRow[];
  invalid: readonly ImportRowProblem[];
  resolve: (name: string) => ResolvedName;
  currentMarketByDealer: ReadonlyMap<string, string | null>; // dealerId → current Market name (null/absent = unmapped)
  currentDistrictByDealer?: ReadonlyMap<string, string | null>; // dealerId → current District (null/absent = none)
  existingMarketByKey: ReadonlyMap<string, string>; // marketNameKey → canonical Market name
  resolutions?: Readonly<Record<number, string>>;
}): ImportPlanRow[] {
  const plan: ImportPlanRow[] = [];
  for (const bad of args.invalid) plan.push({ rowNumber: bad.rowNumber, excelDealer: bad.dealer, excelMarket: bad.market, excelDistrict: bad.district ?? "", status: "INVALID", reason: bad.reason });

  // Excel rows that repeat the same dealer name: identical mapping (Market and District) → harmless duplicate; different → conflict.
  const firstByName = new Map<string, ImportSheetRow>();
  const conflictNames = new Set<string>();
  const dupRows = new Set<number>();
  for (const row of args.rows) {
    const key = nameKey(row.dealer);
    const first = firstByName.get(key);
    if (!first) { firstByName.set(key, row); continue; }
    if (marketNameKey(first.market) === marketNameKey(row.market) && districtKey(first.district) === districtKey(row.district)) dupRows.add(row.rowNumber); else conflictNames.add(key);
  }

  const seenMarketSpelling = new Map<string, string>(); // first spelling used for a brand-new Market within this file
  const byDealer = new Map<string, ImportPlanRow[]>();
  for (const row of args.rows) {
    const base = { rowNumber: row.rowNumber, excelDealer: row.dealer, excelMarket: row.market, excelDistrict: row.district };
    const key = nameKey(row.dealer);
    if (conflictNames.has(key)) { plan.push({ ...base, status: "CONFLICT", reason: "The same Dealer appears with different Markets or Districts in this sheet — fix the sheet." }); continue; }
    if (dupRows.has(row.rowNumber)) { plan.push({ ...base, status: "DUPLICATE", reason: "Repeats an earlier row with the same Dealer, Market and District" }); continue; }

    const resolved = args.resolve(row.dealer);
    let picked: ImportCandidate | null = null;
    let candidates: ImportCandidate[] | undefined;
    if (resolved.kind === "NONE") { plan.push({ ...base, status: "UNMATCHED", reason: "No matching dealer found" }); continue; }
    if (resolved.kind === "SINGLE") {
      if (!resolved.inScope) { plan.push({ ...base, status: "INVALID", reason: "This dealer is outside your authorized scope" }); continue; }
      picked = resolved.candidate;
    } else {
      candidates = resolved.candidates;
      if (!resolved.anyInScope) { plan.push({ ...base, status: "INVALID", reason: "The matching dealers are outside your authorized scope" }); continue; }
      const choice = args.resolutions?.[row.rowNumber];
      picked = choice ? resolved.candidates.find((c) => c.dealerId === choice) ?? null : null;
      if (!picked) { plan.push({ ...base, status: "AMBIGUOUS", reason: "Several possible dealers — choose the right one", candidates }); continue; }
    }

    const marketKey = marketNameKey(row.market);
    const existing = args.existingMarketByKey.get(marketKey);
    const marketName = existing ?? seenMarketSpelling.get(marketKey) ?? cleanMarketName(row.market);
    if (!existing && !seenMarketSpelling.has(marketKey)) seenMarketSpelling.set(marketKey, marketName);
    const current = args.currentMarketByDealer.get(picked.dealerId) ?? null;
    const marketChanged = current == null || marketNameKey(current) !== marketKey;
    const currentDistrict = args.currentDistrictByDealer?.get(picked.dealerId) ?? null;
    const districtName = cleanDistrict(row.district);
    const districtAction: ImportPlanRow["districtAction"] = !districtName ? "UNCHANGED" : currentDistrict == null || !districtKey(currentDistrict) ? "ADD" : districtKey(currentDistrict) === districtKey(districtName) ? "NO_CHANGE" : "CHANGE";
    const districtChanged = districtAction === "ADD" || districtAction === "CHANGE";
    const action: ImportPlanRow["action"] = !marketChanged && !districtChanged ? "NO_CHANGE" : current == null ? "MAP" : "CHANGE";
    const entry: ImportPlanRow = { ...base, status: "MATCHED", dealerId: picked.dealerId, partyName: picked.partyName, currentMarket: current, currentDistrict, marketName, newMarket: marketChanged && !existing, districtName, action, marketChanged, districtChanged, districtAction, candidates };
    const list = byDealer.get(picked.dealerId) ?? [];
    list.push(entry); byDealer.set(picked.dealerId, list);
    plan.push(entry);
  }

  // Two different Excel names that resolve to the SAME dealer: same Market → duplicate; different → conflict. Never guess.
  for (const entries of byDealer.values()) {
    if (entries.length < 2) continue;
    const sameMarket = entries.every((e) => marketNameKey(e.marketName!) === marketNameKey(entries[0]!.marketName!) && districtKey(e.districtName ?? "") === districtKey(entries[0]!.districtName ?? ""));
    entries.forEach((entry, index) => {
      if (sameMarket && index > 0) Object.assign(entry, { status: "DUPLICATE", reason: "Another row maps the same dealer to the same Market and District", action: undefined, marketChanged: false, districtChanged: false, newMarket: false });
      else if (!sameMarket) Object.assign(entry, { status: "CONFLICT", reason: "Several rows map this dealer to different Markets or Districts — fix the sheet.", action: undefined, marketChanged: false, districtChanged: false, newMarket: false });
    });
  }
  return plan.sort((a, b) => a.rowNumber - b.rowNumber);
}

const nameKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export interface ImportSummary { total: number; matched: number; willApply: number; noChange: number; unmatched: number; ambiguous: number; invalid: number; duplicates: number; conflicts: number; newMarkets: number; districtUpdates: number }
export function summarizeImportPlan(plan: readonly ImportPlanRow[]): ImportSummary {
  const count = (status: ImportRowStatus) => plan.filter((r) => r.status === status).length;
  const matched = plan.filter((r) => r.status === "MATCHED");
  const apply = matched.filter((r) => r.action !== "NO_CHANGE");
  return {
    total: plan.length, matched: matched.length, willApply: apply.length, noChange: matched.length - apply.length,
    unmatched: count("UNMATCHED"), ambiguous: count("AMBIGUOUS"), invalid: count("INVALID"), duplicates: count("DUPLICATE"), conflicts: count("CONFLICT"),
    districtUpdates: apply.filter((r) => r.districtChanged).length,
    newMarkets: new Set(apply.filter((r) => r.newMarket).map((r) => marketNameKey(r.marketName!))).size,
  };
}
