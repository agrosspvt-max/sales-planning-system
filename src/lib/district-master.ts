/**
 * District master rules (pure — no database). A District belongs to ONE State, and the State is the existing UserGroup (State Catalogue is
 * per group). Names are unique within a state after normalization; the same name may exist in another state.
 */

export const DISTRICT_NAME_MAX = 120;
/** Display form: trimmed, inner whitespace collapsed, case preserved. */
export const cleanDistrictName = (value: string): string => value.replace(/\s+/g, " ").trim();
/** Comparison key ("Rajgarh" == " RAJGARH " == "raj-garh"): lower-case, punctuation/space collapsed (same rule as Market names). */
export const districtKey = (value: string): string => value.toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, " ").replace(/\s+/g, " ").trim();

const cellText = (v: unknown): string => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());

/* ------------------------------------------------ district list workbook ------------------------------------------------ */

export interface DistrictSheetRow { rowNumber: number; name: string }
export interface DistrictSheetProblem { rowNumber: number; name: string; reason: string }
/**
 * Read a district list sheet (row 0 = header). Required column `District Name`; `S.No` and any other column are ignored. Fully blank rows are
 * skipped; a row that has other content but no name is invalid. Row numbers are the spreadsheet's own (header = row 1).
 */
export function parseDistrictSheet(raw: readonly (readonly unknown[])[]): { error: string | null; rows: DistrictSheetRow[]; invalid: DistrictSheetProblem[] } {
  const header = raw[0] ?? [];
  const nameCol = header.findIndex((c) => cellText(c).toLowerCase() === "district name");
  if (nameCol < 0) return { error: "The selected sheet must have a column named District Name in its first row.", rows: [], invalid: [] };
  const rows: DistrictSheetRow[] = [], invalid: DistrictSheetProblem[] = [];
  raw.slice(1).forEach((cells, index) => {
    const rowNumber = index + 2;
    if (cells.every((c) => cellText(c) === "")) return;
    const name = cleanDistrictName(cellText(cells[nameCol]));
    if (!name || !districtKey(name)) return void invalid.push({ rowNumber, name, reason: "District Name is required" });
    if (name.length > DISTRICT_NAME_MAX) return void invalid.push({ rowNumber, name, reason: `District Name is longer than ${DISTRICT_NAME_MAX} characters` });
    rows.push({ rowNumber, name });
  });
  return { error: null, rows, invalid };
}

export type DistrictImportStatus = "NEW" | "EXISTS" | "INVALID";
export interface DistrictImportRow { rowNumber: number; name: string; status: DistrictImportStatus; reason?: string; existingId?: string; existingActive?: boolean }
export interface ExistingDistrict { id: string; name: string; nameKey: string; isActive: boolean }
export interface DistrictImportSummary { total: number; newCount: number; existing: number; invalid: number; inactiveExisting: number }

/**
 * Plan an upload against ONE state's current districts. Duplicate names inside the file (after normalization) are rejected from the second
 * occurrence on; a name that is already an approved alias of another district is rejected; a name that already exists is reported (EXISTS) and
 * never created again, so re-uploading the same file changes nothing. Districts missing from the file are never touched.
 */
export function planDistrictImport(
  parsed: { rows: readonly DistrictSheetRow[]; invalid: readonly DistrictSheetProblem[] },
  existing: readonly ExistingDistrict[],
  aliasKeys: ReadonlyMap<string, string> = new Map(), // aliasKey → canonical district name
): DistrictImportRow[] {
  const out: DistrictImportRow[] = parsed.invalid.map((p) => ({ rowNumber: p.rowNumber, name: p.name, status: "INVALID" as const, reason: p.reason }));
  const byKey = new Map(existing.map((d) => [d.nameKey, d]));
  const firstRow = new Map<string, number>();
  for (const row of parsed.rows) {
    const key = districtKey(row.name);
    const first = firstRow.get(key);
    if (first !== undefined) { out.push({ rowNumber: row.rowNumber, name: row.name, status: "INVALID", reason: `Duplicate of row ${first} (same district name in this state)` }); continue; }
    firstRow.set(key, row.rowNumber);
    const alias = aliasKeys.get(key);
    const hit = byKey.get(key);
    if (alias && !hit) { out.push({ rowNumber: row.rowNumber, name: row.name, status: "INVALID", reason: `Already an approved alternative spelling of "${alias}"` }); continue; }
    out.push(hit ? { rowNumber: row.rowNumber, name: row.name, status: "EXISTS", existingId: hit.id, existingActive: hit.isActive } : { rowNumber: row.rowNumber, name: row.name, status: "NEW" });
  }
  return out.sort((a, b) => a.rowNumber - b.rowNumber);
}
export function summarizeDistrictImport(plan: readonly DistrictImportRow[]): DistrictImportSummary {
  return {
    total: plan.length, newCount: plan.filter((r) => r.status === "NEW").length, existing: plan.filter((r) => r.status === "EXISTS").length,
    invalid: plan.filter((r) => r.status === "INVALID").length, inactiveExisting: plan.filter((r) => r.status === "EXISTS" && r.existingActive === false).length,
  };
}

/* ------------------------------------------------ resolving district text ------------------------------------------------ */

export interface CatalogDistrict { id: string; groupId: string; name: string; nameKey: string; isActive: boolean }
export interface CatalogAlias { districtId: string; groupId: string; aliasKey: string }
export type DistrictResolution =
  | { kind: "OK"; districtId: string; name: string; viaAlias: boolean }
  | { kind: "UNKNOWN" }
  | { kind: "INACTIVE"; name: string }
  | { kind: "WRONG_STATE"; name: string; groupIds: string[] }
  | { kind: "NO_STATE" }
  | { kind: "AMBIGUOUS"; names: string[] };

/**
 * Resolve free text to a district OF THE DEALER'S STATE (`groupId`), by canonical name or approved alias. Text that only exists in another state
 * is WRONG_STATE (never silently remapped); text that exists nowhere is UNKNOWN. When the dealer's state is unknown nothing is assigned.
 */
export function buildDistrictCatalog(districts: readonly CatalogDistrict[], aliases: readonly CatalogAlias[]) {
  const byId = new Map(districts.map((d) => [d.id, d]));
  const nameIdx = new Map<string, CatalogDistrict[]>(); // key → districts (any state)
  for (const d of districts) nameIdx.set(d.nameKey, [...(nameIdx.get(d.nameKey) ?? []), d]);
  const aliasIdx = new Map<string, { district: CatalogDistrict }[]>();
  for (const a of aliases) { const d = byId.get(a.districtId); if (d) aliasIdx.set(a.aliasKey, [...(aliasIdx.get(a.aliasKey) ?? []), { district: d }]); }
  return {
    resolve(text: string, groupId: string | null): DistrictResolution {
      const key = districtKey(text);
      if (!key) return { kind: "UNKNOWN" };
      const names = nameIdx.get(key) ?? [], aliasHits = (aliasIdx.get(key) ?? []).map((a) => a.district);
      const everywhere = [...new Map([...names, ...aliasHits].map((d) => [d.id, d])).values()];
      if (everywhere.length === 0) return { kind: "UNKNOWN" };
      if (!groupId) return { kind: "NO_STATE" };
      const own = names.filter((d) => d.groupId === groupId), ownAlias = aliasHits.filter((d) => d.groupId === groupId);
      const ownAll = [...new Map([...own, ...ownAlias].map((d) => [d.id, d])).values()];
      if (ownAll.length > 1) return { kind: "AMBIGUOUS", names: ownAll.map((d) => d.name).sort() };
      if (ownAll.length === 1) {
        const d = ownAll[0]!;
        if (!d.isActive) return { kind: "INACTIVE", name: d.name };
        return { kind: "OK", districtId: d.id, name: d.name, viaAlias: own.length === 0 };
      }
      const other = everywhere[0]!;
      return { kind: "WRONG_STATE", name: other.name, groupIds: [...new Set(everywhere.map((d) => d.groupId))] };
    },
  };
}
export type DistrictCatalog = ReturnType<typeof buildDistrictCatalog>;

/* ------------------------------------------------ backfill of existing free text (dry-run planner) ------------------------------------------------ */

export type BackfillStatus = "ALREADY_SET" | "EMPTY" | "MATCHED" | "UNMATCHED" | "CROSS_STATE" | "NO_STATE" | "AMBIGUOUS" | "INACTIVE";
export interface BackfillInput { dealerId: string; text: string | null; districtId: string | null; groupId: string | null }
export interface BackfillRow { dealerId: string; text: string | null; status: BackfillStatus; districtId?: string; districtName?: string; viaAlias?: boolean; detail?: string }
/** Decide, per mapping row, whether its legacy text can be linked to a district. Only an unambiguous district of the dealer's own state is linked. */
export function planDistrictBackfill(rows: readonly BackfillInput[], catalog: DistrictCatalog): BackfillRow[] {
  return rows.map((r): BackfillRow => {
    if (r.districtId) return { dealerId: r.dealerId, text: r.text, status: "ALREADY_SET" };
    if (!r.text || !districtKey(r.text)) return { dealerId: r.dealerId, text: r.text, status: "EMPTY" };
    const res = catalog.resolve(r.text, r.groupId);
    switch (res.kind) {
      case "OK": return { dealerId: r.dealerId, text: r.text, status: "MATCHED", districtId: res.districtId, districtName: res.name, viaAlias: res.viaAlias };
      case "UNKNOWN": return { dealerId: r.dealerId, text: r.text, status: "UNMATCHED" };
      case "NO_STATE": return { dealerId: r.dealerId, text: r.text, status: "NO_STATE" };
      case "WRONG_STATE": return { dealerId: r.dealerId, text: r.text, status: "CROSS_STATE", detail: res.name };
      case "AMBIGUOUS": return { dealerId: r.dealerId, text: r.text, status: "AMBIGUOUS", detail: res.names.join(" / ") };
      case "INACTIVE": return { dealerId: r.dealerId, text: r.text, status: "INACTIVE", detail: res.name };
    }
  });
}

/* ------------------------------------------------ initial seed (state ↔ group resolution) ------------------------------------------------ */

export interface SeedState { key: string; names: string[] } // key = workbook state, names = group names that may stand for it (full name, code…)
export interface SeedGroup { id: string; name: string }
export type SeedResolution = { key: string; groupId: string; groupName: string; via: "override" | "name" } | { key: string; error: string };
/**
 * Map each workbook state to its existing UserGroup. An explicit override (group id) wins; otherwise exactly ONE group must match one of the
 * state's names (case-insensitive, exact). Zero, several, or one group claimed by two states → an error entry: the seed stops, nothing is guessed.
 */
export function resolveSeedGroups(states: readonly SeedState[], groups: readonly SeedGroup[], overrides: Readonly<Record<string, string>> = {}): SeedResolution[] {
  const out: SeedResolution[] = states.map((s): SeedResolution => {
    const forced = overrides[s.key];
    if (forced) {
      const g = groups.find((x) => x.id === forced || x.name.toLowerCase() === forced.toLowerCase());
      return g ? { key: s.key, groupId: g.id, groupName: g.name, via: "override" } : { key: s.key, error: `No group matches the given mapping "${forced}"` };
    }
    const wanted = new Set(s.names.map((n) => n.toLowerCase()));
    const hits = groups.filter((g) => wanted.has(g.name.trim().toLowerCase()));
    if (hits.length === 0) return { key: s.key, error: `No existing group is named ${s.names.map((n) => `"${n}"`).join(" or ")} — pass the group explicitly` };
    if (hits.length > 1) return { key: s.key, error: `Several groups match (${hits.map((g) => `"${g.name}"`).join(", ")}) — pass the group explicitly` };
    return { key: s.key, groupId: hits[0]!.id, groupName: hits[0]!.name, via: "name" };
  });
  const used = new Map<string, string>();
  for (const r of out) {
    if ("error" in r) continue;
    const other = used.get(r.groupId);
    if (other) { const i = out.indexOf(r); out[i] = { key: r.key, error: `Group "${r.groupName}" is already mapped to ${other}` }; } else used.set(r.groupId, r.key);
  }
  return out;
}
