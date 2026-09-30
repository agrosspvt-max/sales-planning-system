/**
 * Dealer DISPLAY name selection (pure). DB-free.
 *   npx tsx src/lib/dealer-display-name.test.ts
 *
 * Proves the display-only rule: alias-preferred, deterministic, never touching identity.
 */
import assert from "node:assert/strict";
import { pickDisplayAlias, dealerDisplayName, type DealerAliasChoice } from "./dealer-display-name";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }

const alias = (id: string, tallyName: string, createdAt: string): DealerAliasChoice => ({ id, tallyName, createdAt });

// CASE 1 — a dealer with one alias shows the alias.
test("CASE 1: one alias → the alias is the display name", () => {
  assert.equal(
    dealerDisplayName("New Nand Beej Bhandar", [alias("a1", "NEW NAND KITNASHAK BHANDAR (TILOKPUR)-UP", "2026-01-01T00:00:00Z")]),
    "NEW NAND KITNASHAK BHANDAR (TILOKPUR)-UP",
  );
});

// CASE 2 — no alias falls back to the dealer's own name (unchanged).
test("CASE 2: no alias → the dealer's own name", () => {
  assert.equal(dealerDisplayName("ABC Dealer", []), "ABC Dealer");
  assert.equal(dealerDisplayName("ABC Dealer", null), "ABC Dealer");
  assert.equal(dealerDisplayName("ABC Dealer", undefined), "ABC Dealer");
});

// CASE 3 — multiple aliases pick ONE deterministically (earliest createdAt, then smallest id).
test("CASE 3: multiple aliases → earliest-created alias, stable across calls", () => {
  const aliases = [
    alias("z", "ABC DEALER BHOPAL", "2026-03-01T00:00:00Z"),
    alias("m", "ABC TRADERS", "2026-01-15T00:00:00Z"),
    alias("a", "ABC TRADERS MP", "2026-02-01T00:00:00Z"),
  ];
  const first = dealerDisplayName("ABC Dealer", aliases);
  assert.equal(first, "ABC TRADERS", "earliest createdAt wins");
  // Order of the input array must not change the result.
  assert.equal(dealerDisplayName("ABC Dealer", [...aliases].reverse()), "ABC TRADERS");
  // Repeated calls are stable.
  assert.equal(dealerDisplayName("ABC Dealer", aliases), first);
});

test("tie on createdAt → smallest alias id wins (deterministic tiebreak)", () => {
  const same = "2026-01-01T00:00:00Z";
  assert.equal(pickDisplayAlias([alias("b", "B NAME", same), alias("a", "A NAME", same)])?.id, "a");
  assert.equal(pickDisplayAlias([alias("a", "A NAME", same), alias("b", "B NAME", same)])?.id, "a");
});

test("blank alias names are ignored; a real alias still wins", () => {
  assert.equal(
    dealerDisplayName("Fallback", [alias("a", "   ", "2026-01-01T00:00:00Z"), alias("b", "REAL ALIAS", "2026-02-01T00:00:00Z")]),
    "REAL ALIAS",
  );
  // Only blank aliases → fall back to the dealer name.
  assert.equal(dealerDisplayName("Fallback", [alias("a", "  ", "2026-01-01T00:00:00Z")]), "Fallback");
});

test("Date and epoch-number createdAt are handled the same as ISO strings", () => {
  const aliases: DealerAliasChoice[] = [
    { id: "x", tallyName: "LATER", createdAt: new Date("2026-05-01T00:00:00Z") },
    { id: "y", tallyName: "EARLIER", createdAt: Date.parse("2026-04-01T00:00:00Z") },
  ];
  assert.equal(pickDisplayAlias(aliases)?.tallyName, "EARLIER");
});

// The EXACT decoration contract every extended surface uses (CN Party dropdown, Territory drawer/recovery,
// Scheme Follow-up): label = alias ?? own name; the dealer id (dropdown VALUE / row identity) is untouched.
test("decoration contract: alias label when present, own name otherwise, id never changes", () => {
  const aliasMap = new Map<string, string>([["d1", "NEW NAND KITNASHAK BHANDAR (TILOKPUR)-UP"]]);
  const dealers = [
    { id: "d1", name: "New Nand Beej Bhandar" }, // has alias → shows alias
    { id: "d2", name: "ABC Dealer" },            // no alias → shows own name
  ];
  const decorated = dealers.map((d) => ({ id: d.id, name: aliasMap.get(d.id) ?? d.name }));
  assert.equal(decorated[0].name, "NEW NAND KITNASHAK BHANDAR (TILOKPUR)-UP", "alias shown when present");
  assert.equal(decorated[1].name, "ABC Dealer", "own name shown when no alias");
  assert.deepEqual(decorated.map((d) => d.id), ["d1", "d2"], "dealer ids (dropdown values / identity) unchanged");
});

test("decoration is display-only: it never invents an id or drops a dealer", () => {
  const aliasMap = new Map<string, string>(); // no aliases at all
  const dealers = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];
  const decorated = dealers.map((d) => ({ id: d.id, name: aliasMap.get(d.id) ?? d.name }));
  assert.deepEqual(decorated, [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }], "unchanged when no aliases exist");
});

console.log(`\n${passed} dealer-display-name tests passed`);
