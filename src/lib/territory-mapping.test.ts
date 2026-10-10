/** Pure Territory Mapping rules: normalization, Add Market validation, sheet parsing and the import plan (no DB). */
import assert from "node:assert/strict";
import { buildImportPlan, classifyMatch, marketNameKey, parseTerritorySheet, summarizeImportPlan, validateMarketRequest, type ImportCandidate, type ResolvedName } from "./territory-mapping";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed += 1; console.log(`  ok  ${name}`); };
const cand = (id: string, matchType = "EXACT"): ImportCandidate & { inScope: boolean } => ({ dealerId: id, partyName: `Party ${id}`, matchType, score: 1, inScope: true });

test("Market names normalize so Pipariya / pipariya / PIPARIYA are one market", () => {
  for (const v of ["Pipariya", "pipariya", " PIPARIYA ", "Pipa-riya".replace("-", ""), "pipariya."]) assert.equal(marketNameKey(v), "pipariya");
  assert.equal(marketNameKey("New  Market"), marketNameKey("new market"));
  assert.notEqual(marketNameKey("Bareli"), marketNameKey("Pipariya"));
});

test("Add Market validation: name, A/B/C potential, positive whole No. of Parties", () => {
  const ok = { marketName: "Pipariya", potential: "A", numberOfParties: 12 };
  assert.equal(validateMarketRequest(ok), null);
  assert.equal(validateMarketRequest({ ...ok, numberOfParties: "12" }), null);
  assert.ok(validateMarketRequest({ ...ok, marketName: "   " }));
  assert.ok(validateMarketRequest({ ...ok, marketName: "x".repeat(121) }));
  for (const potential of ["D", "a", "", null, undefined]) assert.ok(validateMarketRequest({ ...ok, potential }), String(potential));
  for (const n of [0, -1, 1.5, "", "abc", null, undefined, 100001, NaN]) assert.ok(validateMarketRequest({ ...ok, numberOfParties: n }), String(n));
});

test("sheet parsing needs the Dealer and Market columns and reports unusable rows", () => {
  assert.ok(parseTerritorySheet([["Name", "Town"], ["A", "B"]]).error);
  const parsed = parseTerritorySheet([[" dealer ", "MARKET", "Extra"], ["Dealer A", "Pipariya", 1], [null, null], ["", "Bareli"], ["Dealer C", ""], ["Dealer D", "Bareli"]]);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.rows.map((r) => [r.rowNumber, r.dealer, r.market]), [[2, "Dealer A", "Pipariya"], [6, "Dealer D", "Bareli"]]);
  assert.deepEqual(parsed.invalid.map((r) => [r.rowNumber, r.reason]), [[4, "Party Name is empty"], [5, "Market is empty"]]);
});

test("a name is matched automatically only when exactly one dealer is found by a non-fuzzy tier", () => {
  assert.equal(classifyMatch([]).kind, "NONE");
  assert.equal(classifyMatch([cand("d1")]).kind, "SINGLE");
  assert.equal(classifyMatch([cand("d1", "ALIAS")]).kind, "SINGLE");
  assert.equal(classifyMatch([cand("d1"), cand("d2")]).kind, "MANY", "two exact matches are ambiguous");
  assert.equal(classifyMatch([cand("d1", "FUZZY")]).kind, "MANY", "a fuzzy candidate is only ever offered for review");
  const out = classifyMatch([{ ...cand("d1"), inScope: false }, cand("d2")]) as Extract<ResolvedName, { kind: "MANY" }>;
  assert.deepEqual(out.candidates.map((c) => c.dealerId), ["d2"], "possible matches never list dealers outside the caller's scope");
});

const plan = (rows: { dealer: string; market: string; district?: string }[], resolve: Record<string, ResolvedName>, extra: Partial<Parameters<typeof buildImportPlan>[0]> = {}) =>
  buildImportPlan({
    rows: rows.map((r, i) => ({ rowNumber: i + 2, district: "", ...r })), invalid: [], resolve: (name) => resolve[name] ?? { kind: "NONE" },
    currentMarketByDealer: new Map(), existingMarketByKey: new Map(), ...extra,
  });
const single = (id: string, inScope = true): ResolvedName => ({ kind: "SINGLE", candidate: cand(id), inScope });

test("import plan: matched / unmatched / ambiguous / out-of-scope are classified and nothing is auto-picked", () => {
  const rows = [{ dealer: "A", market: "Pipariya" }, { dealer: "B", market: "Bareli" }, { dealer: "C", market: "Pipariya" }, { dealer: "D", market: "Pipariya" }];
  const result = plan(rows, { A: single("d1"), C: { kind: "MANY", candidates: [cand("d2"), cand("d3")], anyInScope: true }, D: single("d9", false) });
  assert.deepEqual(result.map((r) => r.status), ["MATCHED", "UNMATCHED", "AMBIGUOUS", "INVALID"]);
  assert.equal(result[2]!.dealerId, undefined, "an ambiguous row has no dealer until the user chooses");
  assert.equal(result[3]!.reason, "This dealer is outside your authorized scope");
  assert.deepEqual(summarizeImportPlan(result), { total: 4, matched: 1, willApply: 1, noChange: 0, unmatched: 1, ambiguous: 1, invalid: 1, duplicates: 0, conflicts: 0, newMarkets: 1, districtUpdates: 0, unknownDistricts: 0 });
});

test("an ambiguity pick is honoured only for one of that row's own candidates", () => {
  const resolve = { C: { kind: "MANY", candidates: [cand("d2"), cand("d3")], anyInScope: true } satisfies ResolvedName };
  const rows = [{ dealer: "C", market: "Pipariya" }];
  assert.equal(plan(rows, resolve, { resolutions: { 2: "d3" } })[0]!.dealerId, "d3");
  assert.equal(plan(rows, resolve, { resolutions: { 2: "d-other" } })[0]!.status, "AMBIGUOUS", "an unrelated dealer id is ignored");
});

test("existing markets are reused case-insensitively; the current mapping decides map / change / no change", () => {
  const rows = [{ dealer: "A", market: "pipariya" }, { dealer: "B", market: "PIPARIYA" }, { dealer: "C", market: "Bareli" }];
  const result = plan(rows, { A: single("d1"), B: single("d2"), C: single("d3") }, {
    existingMarketByKey: new Map([["pipariya", "Pipariya"]]),
    currentMarketByDealer: new Map([["d1", "Pipariya"], ["d2", "Bareli"]]),
  });
  assert.deepEqual(result.map((r) => [r.marketName, r.newMarket, r.action]), [["Pipariya", false, "NO_CHANGE"], ["Pipariya", false, "CHANGE"], ["Bareli", true, "MAP"]]);
});

test("duplicate Excel rows: identical repeats are duplicates, different Markets for one dealer are a conflict", () => {
  const dup = plan([{ dealer: "A", market: "Pipariya" }, { dealer: "a ", market: "pipariya" }], { A: single("d1"), "a ": single("d1") });
  assert.deepEqual(dup.map((r) => r.status), ["MATCHED", "DUPLICATE"]);
  const conflict = plan([{ dealer: "A", market: "Pipariya" }, { dealer: "A", market: "Bareli" }], { A: single("d1") });
  assert.deepEqual(conflict.map((r) => r.status), ["CONFLICT", "CONFLICT"], "never guess which Market is right");
  // Two different spellings that resolve to the SAME dealer with different Markets.
  const viaDealer = plan([{ dealer: "A", market: "Pipariya" }, { dealer: "A (alias)", market: "Bareli" }], { A: single("d1"), "A (alias)": single("d1") });
  assert.deepEqual(viaDealer.map((r) => r.status), ["CONFLICT", "CONFLICT"]);
});

test("sheet parsing: Dealer | Market | District reads the District; an old Dealer | Market sheet still works", () => {
  const parsed = parseTerritorySheet([["Dealer", "Market", "District"], ["Dealer A", "Market A", " District  A "], ["Dealer B", "Market B", ""], ["Dealer C", "Market C", "x".repeat(121)]]);
  assert.deepEqual(parsed.rows.map((r) => [r.dealer, r.market, r.district]), [["Dealer A", "Market A", "District A"], ["Dealer B", "Market B", ""]]);
  assert.deepEqual(parsed.invalid.map((r) => [r.rowNumber, r.reason]), [[4, "District is longer than 120 characters"]]);
  const old = parseTerritorySheet([["Dealer", "Market"], ["Dealer A", "Market A"]]);
  assert.equal(old.error, null);
  assert.deepEqual(old.rows.map((r) => r.district), [""], "no District column → District left unchanged");
  assert.deepEqual(parseTerritorySheet([["Dealer", "Market", "District"], ["", "M", "D"]]).invalid.map((r) => [r.reason, r.district]), [["Party Name is empty", "D"]]);
});

test("import plan: District + Market are compared with what the dealer has now (the five cases)", () => {
  const rows = [
    { dealer: "A", market: "Sarangpur", district: "Rajgarh" }, // 1 same / same
    { dealer: "B", market: "Sarangpur", district: "Rajgarh" }, // 2 nothing yet
    { dealer: "C", market: "New Market", district: "New District" }, // 3 both change
    { dealer: "D", market: "New Market", district: "Rajgarh" }, // 4 only Market
    { dealer: "E", market: "Sarangpur", district: "New District" }, // 5 only District
    { dealer: "F", market: "Sarangpur", district: "" }, // sheet gave no District → unchanged
  ];
  const result = plan(rows, { A: single("d1"), B: single("d2"), C: single("d3"), D: single("d4"), E: single("d5"), F: single("d6") }, {
    existingMarketByKey: new Map([["sarangpur", "Sarangpur"]]),
    currentMarketByDealer: new Map([["d1", "Sarangpur"], ["d3", "Old Market"], ["d4", "Old Market"], ["d5", "Sarangpur"], ["d6", "Sarangpur"]]),
    currentDistrictByDealer: new Map([["d1", "RAJGARH"], ["d3", "Old District"], ["d4", "Rajgarh"], ["d5", "Old District"], ["d6", "Keep Me"]]),
  });
  const view = result.map((r) => [r.action, r.marketChanged, r.districtAction, r.districtChanged]);
  assert.deepEqual(view, [
    ["NO_CHANGE", false, "NO_CHANGE", false],
    ["MAP", true, "ADD", true],
    ["CHANGE", true, "CHANGE", true],
    ["CHANGE", true, "NO_CHANGE", false],
    ["CHANGE", false, "CHANGE", true],
    ["NO_CHANGE", false, "UNCHANGED", false],
  ]);
  assert.deepEqual([result[2]!.currentDistrict, result[2]!.districtName, result[2]!.currentMarket, result[2]!.marketName], ["Old District", "New District", "Old Market", "New Market"], "the preview carries current + Excel values side by side");
  assert.equal(summarizeImportPlan(result).districtUpdates, 3);
  assert.equal(summarizeImportPlan(result).newMarkets, 1, "only a Market that is really being written counts as new");
});

test("District differences make duplicate rows a conflict; unmatched / ambiguous / out-of-scope rows never carry a change", () => {
  const same = plan([{ dealer: "A", market: "M", district: "Rajgarh" }, { dealer: "A", market: "m", district: " RAJGARH" }], { A: single("d1") });
  assert.deepEqual(same.map((r) => r.status), ["MATCHED", "DUPLICATE"]);
  const diff = plan([{ dealer: "A", market: "M", district: "Rajgarh" }, { dealer: "A", market: "M", district: "Kannauj" }], { A: single("d1") });
  assert.deepEqual(diff.map((r) => r.status), ["CONFLICT", "CONFLICT"]);
  const viaDealer = plan([{ dealer: "A", market: "M", district: "Rajgarh" }, { dealer: "A2", market: "M", district: "Kannauj" }], { A: single("d1"), A2: single("d1") });
  assert.deepEqual(viaDealer.map((r) => r.status), ["CONFLICT", "CONFLICT"]);
  const mixed = plan([{ dealer: "U", market: "M", district: "D" }, { dealer: "B", market: "M", district: "D" }, { dealer: "O", market: "M", district: "D" }],
    { B: { kind: "MANY", candidates: [cand("d2"), cand("d3")], anyInScope: true }, O: single("d9", false) });
  assert.deepEqual(mixed.map((r) => [r.status, r.districtChanged, r.marketChanged, r.excelDistrict]), [["UNMATCHED", undefined, undefined, "D"], ["AMBIGUOUS", undefined, undefined, "D"], ["INVALID", undefined, undefined, "D"]]);
});

console.log(`\n${passed} territory-mapping rule tests passed`);
