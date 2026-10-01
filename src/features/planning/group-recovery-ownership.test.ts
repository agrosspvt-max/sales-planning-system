/**
 * Integration test for the EXACT reassignment bug, running the REAL getGroupRecovery() over a DB-free fake.
 *   npx tsx src/features/planning/group-recovery-ownership.test.ts
 *
 * Scenario (the two reported dealers):
 *   - D1 cmsfnel6b000akw04azewjkbg  — historically in BOTH Sunil's and Shivveer's recovery plans; current owner Shivveer.
 *   - D2 cmsaeqbw10499x8krblsk9lug  — same.
 * Expected CURRENT Territory Recovery:
 *   - Sunil:    D1 ❌  D2 ❌   (historical membership must NOT leak into the current view)
 *   - Shivveer: D1 ✅  D2 ✅
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { Role } from "@prisma/client";
import type { AuthContext } from "@/lib/http";

const SUNIL = "cmsaeqgbr049nx8kr24uxgry1";
const SHIV = "cmsfnelbb000bkw04mzil0rfs";
const D1 = "cmsfnel6b000akw04azewjkbg"; // SESAI-SHIVPURI
const D2 = "cmsaeqbw10499x8krblsk9lug"; // BAHADURPUR
const GROUP = "grp1";
const SEASON = "sea1";
const MONTH = "mon1";

// Dealer row shape returned by recoveryPlan.findMany(... dealers ...).
const dealerRow = (dealerId: string, name: string) => ({
  dealerId, dealer: { name }, outstanding: 0, overdue: 0, due: 0, running: 0,
  outstandingTillDate: 0, runningTillDate: 0, srCr: 0, liveRecovery: 0,
  monthRecoveryPlan: 0, monthRunningRecovery: 0, weekPlans: [],
});

function makeFakePrisma() {
  return {
    userGroup: { findUnique: async () => ({ name: "MP" }) },
    season: { findUnique: async () => ({ name: "Kharif", year: 2026, months: [{ id: MONTH, name: "July", order: 1 }] }) },
    user: {
      findMany: async () => [{ id: SUNIL, name: "Sunil" }, { id: SHIV, name: "Shivveer Singh" }],
    },
    recoveryPlan: {
      findMany: async () => [
        // Sunil's plan still has BOTH dealers as historical RecoveryPlanDealer rows.
        { id: "planSunil", officerId: SUNIL, status: "APPROVED", dealers: [dealerRow(D1, "Banke Bihari"), dealerRow(D2, "Banke Bihari Krishi Sewa Kendra")] },
        // Shivveer's plan also has them (current owner).
        { id: "planShiv", officerId: SHIV, status: "APPROVED", dealers: [dealerRow(D1, "Banke Bihari"), dealerRow(D2, "Banke Bihari Krishi Sewa Kendra")] },
      ],
    },
    agingSnapshot: { findMany: async () => [] },
    agingSnapshotBill: { findMany: async () => [] },
  };
}

const localRequire = createRequire(import.meta.url);
function loadService(prisma: object, ownerByDealer: Map<string, string>) {
  const filename = resolve("src/features/planning", "group-recovery.server.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  const mocks: Record<string, unknown> = {
    "server-only": {},
    "@/lib/prisma": { prisma },
    "@/lib/http": { ApiError: class extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } } },
    "@/features/recovery/service.server": { BUSINESS_WEEK_COUNT: 4, businessWeekOfMonth: () => 1 },
    "@/features/planning/group-plan.server": {
      bucketOfStatus: (s: string) => ({ APPROVED: "approved", SUBMITTED: "submitted", DRAFT: "draft" } as Record<string, string>)[s] ?? null,
      ALL_BUCKETS: ["approved", "submitted", "draft"],
    },
    "@/features/recovery/recovery-calc": {},
    "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map() },
    // The authoritative current owner — the real function is tested separately; here we inject the known truth.
    "@/lib/scope": { getCurrentOwnerByDealer: async () => ownerByDealer },
    // Use the REAL ownership predicate (pure).
    "@/lib/dealer-ownership": localRequire(resolve("src/lib", "dealer-ownership.ts")),
  };
  runInNewContext(code, { exports, console, Date, require: (id: string) => id in mocks ? mocks[id] : localRequire(id.startsWith("@/") ? resolve("src", id.slice(2)) : id) }, { filename });
  return exports as typeof import("./group-recovery.server");
}

const ADMIN: AuthContext = { userId: "admin", role: Role.SUPER_ADMIN, username: "admin", groupId: null } as AuthContext;

async function main() {
  const ownerByDealer = new Map<string, string>([[D1, SHIV], [D2, SHIV]]); // current owner of BOTH = Shivveer
  const svc = loadService(makeFakePrisma(), ownerByDealer);

  const result = await svc.getGroupRecovery(ADMIN, GROUP, SEASON, MONTH, ["approved"]);
  const rowOf = (officerId: string) => result.rows.find((r) => r.officerId === officerId);
  const sunil = rowOf(SUNIL);
  const shiv = rowOf(SHIV);
  const ids = (r: typeof sunil) => (r?.dealers ?? []).map((d) => d.dealerId);

  // Sunil: BOTH dealers must be ABSENT (current owner is Shivveer).
  assert.ok(!ids(sunil).includes(D1), `Sunil must NOT show D1 (SESAI-SHIVPURI). Got: ${JSON.stringify(ids(sunil))}`);
  assert.ok(!ids(sunil).includes(D2), `Sunil must NOT show D2 (BAHADURPUR). Got: ${JSON.stringify(ids(sunil))}`);
  // Shivveer: BOTH must be PRESENT.
  assert.ok(ids(shiv).includes(D1), `Shivveer must show D1. Got: ${JSON.stringify(ids(shiv))}`);
  assert.ok(ids(shiv).includes(D2), `Shivveer must show D2. Got: ${JSON.stringify(ids(shiv))}`);
  console.log("  ok  current owner = Shivveer → both dealers under Shivveer only, never Sunil");

  // Reverse reassignment: move BOTH to Sunil → they must follow Sunil immediately.
  const svc2 = loadService(makeFakePrisma(), new Map([[D1, SUNIL], [D2, SUNIL]]));
  const r2 = await svc2.getGroupRecovery(ADMIN, GROUP, SEASON, MONTH, ["approved"]);
  const s2 = r2.rows.find((r) => r.officerId === SUNIL);
  const v2 = r2.rows.find((r) => r.officerId === SHIV);
  assert.ok((s2?.dealers ?? []).map((d) => d.dealerId).includes(D1), "after reverse, Sunil shows D1");
  assert.ok(!(v2?.dealers ?? []).map((d) => d.dealerId).includes(D1), "after reverse, Shivveer no longer shows D1");
  console.log("  ok  reverse reassignment (→ Sunil) follows current owner");

  console.log("\n2 group-recovery ownership integration tests passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
