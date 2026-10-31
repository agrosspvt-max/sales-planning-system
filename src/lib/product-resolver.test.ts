import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as keys from "./match-key";
import * as merges from "./product-merge";
const require = createRequire(import.meta.url);
const modules: Record<string, unknown> = {
  "server-only": {},
  "@/lib/prisma": {},
  "@/lib/match-key": keys,
  "@/lib/product-merge": merges,
  "@/lib/import/workbook": {},
};
function load<T>(file: string): T {
  const mod = { exports: {} };
  runInNewContext(
    ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      module: mod,
      exports: mod.exports,
      require: (name: string) => modules[name] ?? require(name),
    },
  );
  return mod.exports as T;
}
const { buildProductResolver } = load<typeof import("./product-resolver")>(
  "src/lib/product-resolver.ts",
);
const { cleanProductName } = load<typeof import("../features/sales-upload/parser")>(
  "src/features/sales-upload/parser.ts",
);
const row = (
  name: string,
  id = name,
  canonicalName: string | null = null,
  mergedIntoId: string | null = null,
) => ({ id, name, canonicalName, mergedIntoId, isActive: !mergedIntoId });
const resolver = buildProductResolver([
  row("TRICHO"),
  row("OPEN"),
  row("MAD"),
  row("RAIZA"),
  row("MAXX SELIENO 1KG"),
  row("LINER (1ACER DOSE)"),
  row("JONSON"),
  row("M-POWER"),
]);
for (const [raw, expected] of [
  ["MAXX TRICHO 12X1KG", "TRICHO"],
  ["MAXX OPEN 20X500ML", "OPEN"],
  ["MAXX OPEN 40X250ML", "OPEN"],
  ["MAXX OPEN 50X100ML", "OPEN"],
  ["MAXX OPEN 100 X 25ML", "OPEN"],
  ["MAXX MAD 400X8 GM", "MAD"],
  ["MAXX RAIZA 12X2KG", "RAIZA"],
  ["MAXX SELIENO 20X1KG", "MAXX SELIENO 1KG"],
  ["MAXX SELIENO 6X5KG", "MAXX SELIENO 1KG"],
  ["LINER 8X230ML", "LINER (1ACER DOSE)"],
  ["LINER 16X115ML", "LINER (1ACER DOSE)"],
  ["JONSON PLUS 20X500ML", "JONSON"],
  ["M POWER 10X1LTR", "M-POWER"],
]) {
  const base = cleanProductName(raw);
  assert.equal(
    resolver.resolveProduct(base)?.name,
    expected,
    "existing Sales Upload behavior: " + raw,
  );
  assert.equal(
    resolver.resolveProductUnique(base)?.name,
    expected,
    "automatic sync uses the same product identity: " + raw,
  );
}
assert.equal(resolver.resolveProductUnique("UNREGISTERED ZETA"), null);
const ambiguous = buildProductResolver([row("OPEN RED"), row("OPEN BLUE")]);
assert.equal(
  ambiguous.resolveProductUnique("OPEN"),
  null,
  "equal-score different products stay held",
);
assert.equal(
  ambiguous.resolveProductUnique("OPEN RED")?.id,
  "OPEN RED",
  "exact match wins over substring suggestions",
);
const canonical = buildProductResolver([
  row("OPEN", "survivor", "OPEN"),
  row("MAXX OPEN", "alias", "OPEN"),
  row("LEGACY OPEN", "legacy", null, "survivor"),
]);
assert.equal(canonical.resolveProductUnique("MAXX OPEN")?.id, "survivor");
assert.equal(canonical.resolveProductUnique("LEGACY OPEN")?.id, "survivor");
const duplicate = buildProductResolver([row("OPEN", "one", "OPEN"), row("OPEN", "two", "OPEN")]);
assert.equal(duplicate.resolveProductUnique("OPEN"), null);
console.log(
  "PASS shared product resolver: 13 reported pack/name variants, upload parity, canonical/merged identities, exact priority, unknowns and ambiguous holds",
);
