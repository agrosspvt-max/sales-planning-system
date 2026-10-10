/** Pure District master rules: sheet parsing, import planning (duplicates, idempotency), state-scoped resolution, backfill planning, seed group resolution (no DB). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildDistrictCatalog, districtKey, parseDistrictSheet, planDistrictBackfill, planDistrictImport, resolveSeedGroups, summarizeDistrictImport,
  type CatalogAlias, type CatalogDistrict,
} from "./district-master";
import { buildImportPlan, parseTerritorySheet, type ImportCandidate, type ResolvedName } from "./territory-mapping";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed += 1; console.log(`  ok  ${name}`); };
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

test("District Name sheet (S.No | District Name): blank rows ignored, blank names / over-long names invalid, row numbers are the sheet's own", () => {
  const p = parseDistrictSheet([["S.No", "District Name"], [1, "Agar Malwa"], [null, null], [2, "  Alirajpur  "], [3, ""], [4, "x".repeat(121)], [5, "Anuppur"]]);
  assert.equal(p.error, null);
  assert.deepEqual(plain(p.rows), [{ rowNumber: 2, name: "Agar Malwa" }, { rowNumber: 4, name: "Alirajpur" }, { rowNumber: 7, name: "Anuppur" }]);
  assert.deepEqual(p.invalid.map((r) => [r.rowNumber, r.reason]), [[5, "District Name is required"], [6, "District Name is longer than 120 characters"]]);
  assert.match(parseDistrictSheet([["S.No", "Name"], [1, "X"]]).error ?? "", /District Name/, "the District Name column is required");
  assert.equal(parseDistrictSheet([["district NAME"], ["Bhind"]]).rows.length, 1, "header is case-insensitive; S.No is optional");
});

test("import plan: duplicate names in one state are rejected after normalization; the same name in another state is fine", () => {
  const parsed = parseDistrictSheet([["District Name"], ["Bara Banki"], ["BARA-BANKI"], ["Agra"], [" agra "], ["Hardoi"]]);
  const plan = planDistrictImport(parsed, []);
  assert.deepEqual(plan.map((r) => [r.rowNumber, r.status]), [[2, "NEW"], [3, "INVALID"], [4, "NEW"], [5, "INVALID"], [6, "NEW"]]);
  assert.match(plan[1]!.reason!, /Duplicate of row 2/);
  assert.deepEqual(summarizeDistrictImport(plan), { total: 5, newCount: 3, existing: 0, invalid: 2, inactiveExisting: 0 });
  // Uniqueness is per state: another state's list may hold the same name.
  const other = planDistrictImport(parseDistrictSheet([["District Name"], ["Bilaspur"]]), []);
  assert.equal(other[0]!.status, "NEW");
  assert.equal(districtKey("Bilaspur"), districtKey(" BILASPUR "));
});

test("re-uploading the same file is idempotent; districts missing from the file are never touched; inactive ones stay inactive", () => {
  const first = parseDistrictSheet([["District Name"], ["Agra"], ["Aligarh"]]);
  const existing = [{ id: "1", name: "Agra", nameKey: "agra", isActive: true }, { id: "2", name: "Aligarh", nameKey: "aligarh", isActive: false }, { id: "3", name: "Banda", nameKey: "banda", isActive: true }];
  const plan = planDistrictImport(first, existing);
  assert.deepEqual(plan.map((r) => r.status), ["EXISTS", "EXISTS"], "nothing new → nothing to create");
  assert.equal(plan.some((r) => r.name === "Banda"), false, "Banda is simply not mentioned (never deleted)");
  assert.equal(summarizeDistrictImport(plan).inactiveExisting, 1);
  assert.deepEqual(plan.map((r) => r.existingActive), [true, false]);
});

test("a name that is already an approved alias of another district is rejected, not created as a second district", () => {
  const plan = planDistrictImport(parseDistrictSheet([["District Name"], ["Barabanki"], ["Bara Banki"]]), [{ id: "1", name: "Bara Banki", nameKey: "bara banki", isActive: true }], new Map([["barabanki", "Bara Banki"]]));
  assert.deepEqual(plan.map((r) => r.status), ["INVALID", "EXISTS"]);
  assert.match(plan[0]!.reason!, /Bara Banki/);
});

const D = (id: string, groupId: string, name: string, isActive = true): CatalogDistrict => ({ id, groupId, name, nameKey: districtKey(name), isActive });
const districts = [D("mp-raj", "MP", "Rajgarh"), D("mp-bilas", "MP", "Sehore"), D("up-kan", "UP", "Kannauj"), D("up-bb", "UP", "Bara Banki"), D("cg-bilas", "CG", "Bilaspur"), D("up-bilas", "UP", "Bilaspur"), D("up-old", "UP", "Old Town", false)];
const aliases: CatalogAlias[] = [{ districtId: "up-bb", groupId: "UP", aliasKey: districtKey("Barabanki") }];
const catalog = buildDistrictCatalog(districts, aliases);

test("resolution is by the DEALER'S state: canonical name, approved alias, same name in two states, cross-state, unknown, no state, inactive", () => {
  assert.deepEqual(plain(catalog.resolve(" RAJGARH ", "MP")), { kind: "OK", districtId: "mp-raj", name: "Rajgarh", viaAlias: false });
  assert.deepEqual(plain(catalog.resolve("Barabanki", "UP")), { kind: "OK", districtId: "up-bb", name: "Bara Banki", viaAlias: true }, "a known spelling variant maps to the canonical district");
  assert.equal(catalog.resolve("Bilaspur", "CG").kind === "OK" && (catalog.resolve("Bilaspur", "CG") as { districtId: string }).districtId, "cg-bilas", "a name shared by two states resolves inside the dealer's own state");
  assert.equal((catalog.resolve("Bilaspur", "UP") as { districtId: string }).districtId, "up-bilas");
  const wrong = catalog.resolve("Kannauj", "MP");
  assert.deepEqual(plain(wrong), { kind: "WRONG_STATE", name: "Kannauj", groupIds: ["UP"] });
  assert.equal(catalog.resolve("Nowhere", "MP").kind, "UNKNOWN");
  assert.equal(catalog.resolve("Rajgarh", null).kind, "NO_STATE", "no state → nothing is assigned");
  assert.equal(catalog.resolve("Nowhere", null).kind, "UNKNOWN");
  assert.equal(catalog.resolve("Old Town", "UP").kind, "INACTIVE");
  assert.equal(catalog.resolve("", "MP").kind, "UNKNOWN");
  const clash = buildDistrictCatalog([...districts, D("mp-x", "MP", "Rajgarh Two")], [...aliases, { districtId: "mp-x", groupId: "MP", aliasKey: districtKey("Rajgarh") }]);
  assert.equal(clash.resolve("Rajgarh", "MP").kind, "AMBIGUOUS", "text that names one district and is an alias of another is never guessed");
});

test("backfill plan: only an unambiguous district of the dealer's own state is linked; everything else is reported and left alone", () => {
  const rows = planDistrictBackfill([
    { dealerId: "a", text: "rajgarh", districtId: null, groupId: "MP" }, // matched
    { dealerId: "b", text: "Barabanki", districtId: null, groupId: "UP" }, // matched via alias
    { dealerId: "c", text: "Kannauj", districtId: null, groupId: "MP" }, // cross-state
    { dealerId: "d", text: "UNKNOWN", districtId: null, groupId: "MP" }, // unmatched
    { dealerId: "e", text: "Rajgarh", districtId: null, groupId: null }, // no state
    { dealerId: "f", text: "Rajgarh", districtId: "mp-raj", groupId: "MP" }, // already set
    { dealerId: "g", text: "  ", districtId: null, groupId: "MP" }, // empty
    { dealerId: "h", text: "Old Town", districtId: null, groupId: "UP" }, // inactive
  ], catalog);
  assert.deepEqual(rows.map((r) => r.status), ["MATCHED", "MATCHED", "CROSS_STATE", "UNMATCHED", "NO_STATE", "ALREADY_SET", "EMPTY", "INACTIVE"]);
  assert.deepEqual(rows.filter((r) => r.status === "MATCHED").map((r) => [r.dealerId, r.districtId, r.viaAlias]), [["a", "mp-raj", false], ["b", "up-bb", true]]);
  assert.equal(rows[2]!.detail, "Kannauj");
});

test("seed: each state maps to exactly ONE existing group (override, full name or code); zero / several / shared → stop, never guess", () => {
  const states = [{ key: "MP", names: ["Madhya Pradesh", "MP"] }, { key: "UP", names: ["Uttar Pradesh", "UP"] }, { key: "CG", names: ["Chhattisgarh", "CG"] }, { key: "WB", names: ["West Bengal", "WB"] }];
  const groups = [{ id: "g1", name: "MP" }, { id: "g2", name: "Uttar Pradesh" }, { id: "g3", name: "UP " }, { id: "g4", name: "cg" }];
  const r = resolveSeedGroups(states, groups);
  assert.deepEqual(plain(r.find((x) => x.key === "MP")), { key: "MP", groupId: "g1", groupName: "MP", via: "name" }, "a group named with the state's code is accepted");
  assert.ok("error" in r.find((x) => x.key === "UP")!, "two groups (full name AND code) match UP → ambiguous → error");
  assert.deepEqual(plain(r.find((x) => x.key === "CG")), { key: "CG", groupId: "g4", groupName: "cg", via: "name" }, "case-insensitive");
  assert.match((r.find((x) => x.key === "WB") as { error: string }).error, /No existing group/, "a missing group is reported, never created");
  const forced = resolveSeedGroups(states, groups, { UP: "g2", WB: "g1" });
  assert.deepEqual(plain(forced.find((x) => x.key === "UP")), { key: "UP", groupId: "g2", groupName: "Uttar Pradesh", via: "override" });
  assert.ok("error" in forced.find((x) => x.key === "WB")! || "error" in forced.find((x) => x.key === "MP")!, "one group claimed by two states is an error");
  assert.ok("error" in resolveSeedGroups(states, groups, { UP: "nope" }).find((x) => x.key === "UP")!);
});

test("standard import headers: District | Market | Party Name in any order; legacy Dealer header still works; Party Name wins when both exist", () => {
  const std = parseTerritorySheet([["Party Name", "District", "Market"], ["A Traders", "Rajgarh", "Sarangpur"]]);
  assert.deepEqual(plain(std.rows), [{ rowNumber: 2, dealer: "A Traders", market: "Sarangpur", district: "Rajgarh" }]);
  assert.deepEqual(plain(parseTerritorySheet([["market", "DISTRICT", " party  name "], ["M", "D", "P"]]).rows[0]), { rowNumber: 2, dealer: "P", market: "M", district: "D" }, "case / spacing insensitive");
  assert.equal(parseTerritorySheet([["Dealer", "Market", "District"], ["Old Style", "M", "D"]]).rows[0]!.dealer, "Old Style", "legacy Dealer header");
  assert.equal(parseTerritorySheet([["Dealer", "Party Name", "Market"], ["X", "Y", "M"]]).rows[0]!.dealer, "Y");
  assert.match(parseTerritorySheet([["Name", "Market"], ["x", "y"]]).error ?? "", /Party Name \(or Dealer\) and Market/);
});

test("import plan with the District master: unknown / cross-state rows are blocked WHOLE, alias is flagged, blank keeps the current district", () => {
  const single = (id: string): ResolvedName => ({ kind: "SINGLE", candidate: { dealerId: id, partyName: `Party ${id}`, matchType: "EXACT", score: 1 } as ImportCandidate, inScope: true });
  const many = (): ResolvedName => ({ kind: "MANY", candidates: [{ dealerId: "d1", partyName: "P1", matchType: "EXACT", score: 1 }, { dealerId: "d2", partyName: "P2", matchType: "EXACT", score: 1 }], anyInScope: true });
  const stateOf: Record<string, string | null> = { d1: "MP", d2: "MP", d3: "MP", d4: "UP", d5: null, d6: "UP" };
  const result = buildImportPlan({
    rows: [
      { rowNumber: 2, dealer: "A", market: "New Market", district: "Rajgarh" }, // ok
      { rowNumber: 3, dealer: "B", market: "New Market", district: "Nowhere" }, // unknown
      { rowNumber: 4, dealer: "C", market: "New Market", district: "Kannauj" }, // wrong state
      { rowNumber: 5, dealer: "D", market: "M2", district: "Barabanki" }, // alias (UP)
      { rowNumber: 6, dealer: "E", market: "New Market", district: "Rajgarh" }, // no state
      { rowNumber: 7, dealer: "F", market: "M2", district: "" }, // blank keeps
      { rowNumber: 8, dealer: "G", market: "M2", district: "Rajgarh" }, // ambiguous dealer
    ], invalid: [],
    resolve: (n) => (n === "G" ? many() : single({ A: "d1", B: "d3", C: "d3", D: "d4", E: "d5", F: "d6" }[n]!)),
    currentMarketByDealer: new Map(), existingMarketByKey: new Map(),
    currentDistrictByDealer: new Map([["d6", "Kannauj"]]), currentDistrictIdByDealer: new Map([["d6", "up-kan"]]),
    resolveDistrict: (dealerId, text) => {
      const res = catalog.resolve(text, stateOf[dealerId] ?? null);
      return res.kind === "OK" ? { kind: "OK", districtId: res.districtId, name: res.name, viaAlias: res.viaAlias } : res.kind === "UNKNOWN" ? { kind: "UNKNOWN" } : { kind: "INVALID", reason: res.kind };
    },
  });
  const by = (n: number) => result.find((r) => r.rowNumber === n)!;
  assert.deepEqual([by(2).status, by(2).districtId, by(2).districtAction], ["MATCHED", "mp-raj", "ADD"]);
  assert.equal(by(3).status, "UNKNOWN_DISTRICT"); assert.equal(by(3).marketChanged, undefined, "an unknown district leaves the row's Market change out too");
  assert.deepEqual([by(4).status, by(4).reason], ["INVALID", "WRONG_STATE"]);
  assert.deepEqual([by(5).status, by(5).districtName, by(5).districtViaAlias], ["MATCHED", "Bara Banki", true]);
  assert.deepEqual([by(6).status, by(6).reason], ["INVALID", "NO_STATE"]);
  assert.deepEqual([by(7).status, by(7).districtAction, by(7).districtChanged, by(7).marketChanged], ["MATCHED", "UNCHANGED", false, true], "a blank District cell leaves the district alone (the Market still maps)");
  assert.equal(by(8).status, "AMBIGUOUS", "dealer ambiguity is handled exactly as before");
});

test("the supplied workbooks (when present on this machine) are clean and consistent", () => {
  const dir = `${process.env.HOME}/Downloads`;
  let exists = true;
  try { readFileSync(`${dir}/Madhya_Pradesh_Districts.xlsx`); } catch { exists = false; }
  if (!exists) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const XLSX = require("xlsx") as typeof import("xlsx");
  const counts: Record<string, number> = {}, names: Record<string, Set<string>> = {};
  for (const [key, file, expected] of [["MP", "Madhya_Pradesh", 55], ["UP", "Uttar_Pradesh", 75], ["CG", "Chhattisgarh", 33], ["WB", "West_Bengal", 23]] as const) {
    const wb = XLSX.readFile(`${dir}/${file}_Districts.xlsx`);
    const parsed = parseDistrictSheet(XLSX.utils.sheet_to_json(wb.Sheets["Districts"]!, { header: 1, blankrows: true, defval: null }) as unknown[][]);
    assert.equal(parsed.error, null); assert.equal(parsed.invalid.length, 0, `${key}: no invalid rows`);
    const plan = planDistrictImport(parsed, []);
    assert.equal(plan.filter((r) => r.status === "INVALID").length, 0, `${key}: no duplicates after normalization`);
    counts[key] = plan.length; assert.equal(plan.length, expected, `${key} district count`);
    names[key] = new Set(parsed.rows.map((r) => districtKey(r.name)));
  }
  assert.deepEqual(counts, { MP: 55, UP: 75, CG: 33, WB: 23 });
  // The proposed aliases only ever point at a real district of their own state, and never shadow another canonical name.
  const aliasFile = JSON.parse(readFileSync("scripts/district-aliases.json", "utf8")) as Record<string, Record<string, string>>;
  for (const [state, map] of Object.entries(aliasFile)) {
    if (state.startsWith("_")) continue;
    for (const [alias, canonical] of Object.entries(map)) {
      assert.ok(names[state]!.has(districtKey(canonical)), `${state}: alias "${alias}" → "${canonical}" exists in that state's list`);
      assert.ok(!names[state]!.has(districtKey(alias)), `${state}: alias "${alias}" is not itself a canonical district name`);
    }
  }
});

console.log(`\n${passed} district-master rule tests passed`);
