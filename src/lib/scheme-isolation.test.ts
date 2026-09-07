/**
 * Phase 8 — Scheme domain ISOLATION harness (static, no DB).
 *
 * The core architectural guarantee of the entire Scheme feature is that it NEVER mutates normal Sales
 * Planning data. This suite scans the source of every scheme **server** module and asserts none of them
 * performs a write on a normal Sales-Planning table, nor reaches into the normal Sales Upload commit path.
 * It complements the per-flow unit tests: those prove behaviour; this proves the boundary can't be crossed
 * anywhere in the scheme domain. Runnable: `npx tsx src/lib/scheme-isolation.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// Every scheme-domain server module (the only code that talks to the DB for schemes).
const SCHEME_SERVER_MODULES = [
  "scheme-master.server.ts",
  "scheme-planning.server.ts",
  "scheme-achievement.server.ts",
  "scheme-follow-up.server.ts",
  "scheme-enrolled.server.ts",
  "scheme-payments.server.ts",
  "scheme-upload.server.ts",
];

// Normal Sales-Planning tables (Prisma client accessors) the scheme domain must never write to.
const FORBIDDEN_TABLES = ["monthlyEntry", "planLine", "planDealer", "salesUploadRun", "seasonPlan", "seasonMonth"];
const WRITE_OPS = ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"];

const srcOf = (file: string) => readFileSync(fileURLToPath(new URL(`../features/schemes/${file}`, import.meta.url)), "utf8");

// Match ACTUAL prisma/tx accessors (dotted) so doc-comment mentions like "MonthlyEntry" don't false-positive.
function forbiddenWrites(src: string): string[] {
  const hits: string[] = [];
  for (const table of FORBIDDEN_TABLES) {
    // e.g. prisma.monthlyEntry.create( … )  or  tx.planLine.updateMany( …
    const re = new RegExp(`\\b(?:prisma|tx|client)\\.${table}\\.(?:${WRITE_OPS.join("|")})\\b`, "g");
    const m = src.match(re);
    if (m) hits.push(...m);
  }
  return hits;
}

/* --------------------------------- per-module: no forbidden writes --------------------------------- */

for (const file of SCHEME_SERVER_MODULES) {
  test(`ISOLATION: ${file} never writes a normal Sales-Planning table`, () => {
    const src = srcOf(file);
    const hits = forbiddenWrites(src);
    assert.deepEqual(hits, [], `${file} performs forbidden write(s): ${hits.join(", ")}`);
  });
}

/* --------------------------------- domain-wide: no normal-upload commit path --------------------------------- */

test("ISOLATION: no scheme module calls the normal Sales Upload commit/analyze", () => {
  for (const file of SCHEME_SERVER_MODULES) {
    const src = srcOf(file);
    assert.ok(!src.includes("commitSalesUpload"), `${file} must not call commitSalesUpload`);
    assert.ok(!src.includes("analyzeSalesUpload"), `${file} must not call analyzeSalesUpload`);
  }
});

test("ISOLATION: no scheme module even references a normal Sales-Planning table accessor", () => {
  // Stronger than the write check: the scheme domain should not read these tables either (its own
  // DealerSchemePlan / SchemeUploadBatchScheme / SchemeSale carry everything it needs).
  for (const file of SCHEME_SERVER_MODULES) {
    const src = srcOf(file);
    for (const table of FORBIDDEN_TABLES) {
      const re = new RegExp(`\\b(?:prisma|tx|client)\\.${table}\\b`);
      assert.ok(!re.test(src), `${file} references normal Sales-Planning table .${table}`);
    }
  }
});

/* --------------------------------- Scheme Upload writes only its three tables --------------------------------- */

test("ISOLATION: Scheme Upload commit writes ONLY the three scheme tracking tables", () => {
  const src = srcOf("scheme-upload.server.ts");
  // Collect every write accessor and assert its table is one of the allowed scheme-tracking tables.
  const ALLOWED = ["schemeUploadBatch", "schemeUploadBatchScheme", "schemeSale", "auditLog"];
  const re = new RegExp(`\\b(?:prisma|tx)\\.([a-zA-Z]+)\\.(?:${WRITE_OPS.join("|")})\\b`, "g");
  let m: RegExpExecArray | null;
  const writtenTables = new Set<string>();
  while ((m = re.exec(src)) !== null) writtenTables.add(m[1]);
  for (const t of writtenTables) {
    assert.ok(ALLOWED.includes(t), `scheme-upload.server.ts writes unexpected table: ${t}`);
  }
  // And it must actually write the scheme tables (guards against the regex silently matching nothing).
  assert.ok(writtenTables.has("schemeUploadBatch") && writtenTables.has("schemeUploadBatchScheme") && writtenTables.has("schemeSale"), "expected scheme-upload to write its three tables");
});

console.log(`\n${passed} passed`);
