/**
 * READ-ONLY product-duplicate impact report for 3 pairs (canonical ← duplicate):
 *   Zacker ← Zecer
 *   Tandab ← Taandab
 *   Adbhut ← Adbut
 *
 * Case-INSENSITIVE matching (Master names may be uppercase, e.g. ADBHUT / ADBUT).
 * It ONLY runs SELECTs inside a READ ONLY transaction — it cannot modify anything.
 * Run from the project root (where .env with DIRECT_URL/DATABASE_URL lives):
 *
 *     node product-merge-report.js
 *
 * Needs the `pg` package (already a transitive dep; if missing: `npm i pg`).
 */
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

// --- read DIRECT_URL (preferred) or DATABASE_URL from .env, no dotenv needed ---
function envUrl() {
  const envPath = path.resolve(process.cwd(), ".env");
  const txt = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const pick = (k) => (txt.match(new RegExp("^" + k + '=\\"?([^\\"\\n]+)\\"?', "m")) || [])[1];
  return process.env.DIRECT_URL || pick("DIRECT_URL") || process.env.DATABASE_URL || pick("DATABASE_URL");
}

const PAIRS = [
  { canonical: "Zacker", duplicate: "Zecer" },
  { canonical: "Tandab", duplicate: "Taandab" },
  { canonical: "Adbhut", duplicate: "Adbut" },
];
const lc = (s) => (s == null ? "" : String(s).toLowerCase());
const NAMES = PAIRS.flatMap((p) => [p.canonical, p.duplicate]);
const NAMES_LC = NAMES.map(lc);                                  // case-insensitive name list
const PAIRS_LC = PAIRS.flatMap((p) => [lc(p.canonical), lc(p.duplicate)]); // for (canonical,duplicate) IN (...)
const PAIR_TUPLES = PAIRS.map((_, i) => `($${i * 2 + 1},$${i * 2 + 2})`).join(",");

async function main() {
  const url = envUrl();
  if (!url) { console.error("No DIRECT_URL/DATABASE_URL found."); process.exit(1); }
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("BEGIN TRANSACTION READ ONLY"); // hard guarantee: no writes possible

  const q = (text, params) => c.query(text, params).then((r) => r.rows);

  // 1) Products — ids, names, active status (case-insensitive)
  const products = await q(
    `SELECT id, name, "isActive", "createdAt" FROM "Product" WHERE LOWER(name) = ANY($1) ORDER BY name`, [NAMES_LC]
  );
  const byName = Object.fromEntries(products.map((p) => [lc(p.name), p]));

  console.log("\n=== 1) PRODUCT ROWS ===");
  for (const p of PAIRS) {
    const cRow = byName[lc(p.canonical)], dRow = byName[lc(p.duplicate)];
    console.log(`\n${p.duplicate} → ${p.canonical}`);
    console.log(`  canonical ${p.canonical}: ${cRow ? `${cRow.name} | ${cRow.id} active=${cRow.isActive}` : "NOT FOUND"}`);
    console.log(`  duplicate ${p.duplicate}: ${dRow ? `${dRow.name} | ${dRow.id} active=${dRow.isActive}` : "NOT FOUND"}`);
  }

  // 2) GroupProductCatalogue — per product (state, active, price)
  const cat = await q(
    `SELECT p.name AS product, ug.name AS state, gpc."isActive", gpc.price
       FROM "GroupProductCatalogue" gpc
       JOIN "Product" p ON p.id = gpc."productId"
       JOIN "UserGroup" ug ON ug.id = gpc."groupId"
      WHERE LOWER(p.name) = ANY($1) ORDER BY product, state`, [NAMES_LC]
  );
  console.log("\n=== 2) GROUP (STATE) CATALOGUE REFERENCES ===");
  if (cat.length === 0) console.log("  (none)");
  for (const r of cat) console.log(`  ${String(r.product).padEnd(10)} | state=${r.state} | active=${r.isactive} | price=${r.price}`);

  // 3/8) Groups that have BOTH (catalogue collision) — case-insensitive pair match
  const catBoth = await q(
    `SELECT ug.name AS state, cc.name AS canonical, dd.name AS duplicate
       FROM "GroupProductCatalogue" gc
       JOIN "Product" cc ON cc.id = gc."productId"
       JOIN "GroupProductCatalogue" gd ON gd."groupId" = gc."groupId"
       JOIN "Product" dd ON dd.id = gd."productId"
       JOIN "UserGroup" ug ON ug.id = gc."groupId"
      WHERE (LOWER(cc.name), LOWER(dd.name)) IN (${PAIR_TUPLES})`, PAIRS_LC
  );
  console.log("\n=== 3/8) CATALOGUE COLLISIONS (group already has BOTH) ===");
  console.log(catBoth.length ? catBoth.map((r) => `  ${r.duplicate}→${r.canonical} | state=${r.state}`).join("\n") : "  none");

  // 4) PlanLine references, split seasonal vs monthly (SeasonPlan.planningType)
  const lines = await q(
    `SELECT p.name AS product, sp."planningType" AS type, count(*)::int AS plan_lines
       FROM "PlanLine" pl
       JOIN "Product" p ON p.id = pl."productId"
       JOIN "PlanDealer" pd ON pd.id = pl."planDealerId"
       JOIN "SeasonPlan" sp ON sp.id = pd."seasonPlanId"
      WHERE LOWER(p.name) = ANY($1)
      GROUP BY product, type ORDER BY product, type`, [NAMES_LC]
  );
  console.log("\n=== 4) PLANLINE REFERENCES (type = SeasonPlan.planningType) ===");
  if (lines.length === 0) console.log("  (none)");
  for (const r of lines) console.log(`  ${String(r.product).padEnd(10)} | ${String(r.type).padEnd(10)} | plan_lines=${r.plan_lines}`);

  // 6/8) PlanLine collisions — a plan-dealer with BOTH products (+ what the dup line carries)
  const lineBoth = await q(
    `SELECT dd.name AS duplicate, cc.name AS canonical, plc."planDealerId" AS plan_dealer,
            (SELECT count(*) FROM "PlanLinePack" k WHERE k."planLineId" = pld.id)::int AS dup_packs,
            (SELECT count(*) FROM "MonthlyEntry" m WHERE m."planLineId" = pld.id)::int AS dup_month_entries,
            (SELECT coalesce(sum(m."saleQty"),0) FROM "MonthlyEntry" m WHERE m."planLineId" = pld.id)::int AS dup_sale_qty
       FROM "PlanLine" plc
       JOIN "Product" cc ON cc.id = plc."productId"
       JOIN "PlanLine" pld ON pld."planDealerId" = plc."planDealerId"
       JOIN "Product" dd ON dd.id = pld."productId"
      WHERE (LOWER(cc.name), LOWER(dd.name)) IN (${PAIR_TUPLES})`, PAIRS_LC
  );
  console.log("\n=== 6/8) PLANLINE COLLISIONS (same plan-dealer has BOTH) ===");
  console.log(lineBoth.length
    ? lineBoth.map((r) => `  ${r.duplicate}→${r.canonical} | planDealer=${r.plan_dealer} | dupPacks=${r.dup_packs} dupMonthEntries=${r.dup_month_entries} dupSaleQty=${r.dup_sale_qty}`).join("\n")
    : "  none");

  // 7) Sales / monthly history on each product's lines
  const sales = await q(
    `SELECT p.name AS product,
            count(*) FILTER (WHERE me."saleQty" <> 0 OR coalesce(me."saleValue",0) <> 0)::int AS months_with_sales,
            coalesce(sum(me."saleQty"),0)::int AS total_sale_qty,
            coalesce(sum(me."planQty"),0)::int AS total_plan_qty
       FROM "MonthlyEntry" me
       JOIN "PlanLine" pl ON pl.id = me."planLineId"
       JOIN "Product" p ON p.id = pl."productId"
      WHERE LOWER(p.name) = ANY($1) GROUP BY product ORDER BY product`, [NAMES_LC]
  );
  console.log("\n=== 7) SALES / MONTHLY HISTORY (attached to PlanLine → follows a merge automatically) ===");
  if (sales.length === 0) console.log("  (none)");
  for (const r of sales) console.log(`  ${String(r.product).padEnd(10)} | monthsWithSales=${r.months_with_sales} saleQty=${r.total_sale_qty} planQty=${r.total_plan_qty}`);

  // 9) Denormalised admin-edit audit (FK-free — informational, never repointed)
  const audit = await q(
    `SELECT "productName" AS product, count(*)::int AS rows FROM "AdminEditAudit"
      WHERE LOWER("productName") = ANY($1) OR "productId" = ANY($2)
      GROUP BY 1 ORDER BY 1`,
    [NAMES_LC, products.map((p) => p.id)]
  );
  console.log("\n=== 9) AdminEditAudit (FK-free history — leave as-is) ===");
  console.log(audit.length ? audit.map((r) => `  ${r.product ?? "(null name)"} | rows=${r.rows}`).join("\n") : "  none");

  // ---- Summary table (all comparisons case-insensitive) ----
  console.log("\n=== SUMMARY ===");
  console.log("duplicate→canonical | dupCatalogue | dupPlanLines | dupSaleQty | catalogueCollision | planLineCollision | action");
  for (const p of PAIRS) {
    const dupCat = cat.filter((r) => lc(r.product) === lc(p.duplicate)).length;
    const dupLines = lines.filter((r) => lc(r.product) === lc(p.duplicate)).reduce((s, r) => s + r.plan_lines, 0);
    const dupSale = (sales.find((r) => lc(r.product) === lc(p.duplicate)) || {}).total_sale_qty ?? 0;
    const catColl = catBoth.filter((r) => lc(r.duplicate) === lc(p.duplicate)).length;
    const lnColl = lineBoth.filter((r) => lc(r.duplicate) === lc(p.duplicate)).length;
    const dupExists = !!byName[lc(p.duplicate)];
    const canonExists = !!byName[lc(p.canonical)];
    let action;
    if (!dupExists) action = "duplicate not found — nothing to do";
    else if (!canonExists) action = "SIMPLE RENAME (canonical does not exist yet)";
    else if (dupCat === 0 && dupLines === 0) action = "SIMPLE: delete/deactivate duplicate (no references)";
    else if (catColl === 0 && lnColl === 0) action = "MERGE: repoint refs, then remove duplicate";
    else action = "MERGE + DEDUPE collisions (special handling)";
    console.log(`  ${p.duplicate}→${p.canonical} | ${dupCat} | ${dupLines} | ${dupSale} | ${catColl} | ${lnColl} | ${action}`);
  }

  await c.query("ROLLBACK"); // nothing was written, but be explicit
  await c.end();
  console.log("\n(READ ONLY — no changes were made.)");
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
