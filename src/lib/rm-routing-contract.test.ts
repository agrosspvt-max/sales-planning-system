/**
 * Cross-module RM-routing contract (source-level regression guard). DB-free.
 *   npx tsx src/lib/rm-routing-contract.test.ts
 *
 * The global rule — an SO submission goes to PENDING_RM only when an applicable RM exists, else straight to
 * Admin (PENDING_ADMIN / PENDING_APPROVAL) — is enforced in every submission flow by consulting the single
 * authority `getCurrentManagerId(ownerId)` and mapping its null result to the admin state. This test fails
 * if any submission service stops consulting that authority or reintroduces a role-only PENDING_RM branch,
 * which is exactly the bug that had regressed Scheme Planning. It complements the behavioural tests
 * (scheme-rm-routing.test.ts for the changed module) by locking the contract for the unchanged modules too.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }

const read = (p: string) => readFileSync(resolve(p), "utf8");

/** Strip block + line comments so we assert on real code, not documentation prose. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** A submission flow file + the admin-pending token its enum uses for "skip RM". */
const MODULES: { label: string; file: string; adminState: string }[] = [
  { label: "Seasonal/Yearly", file: "src/features/planning/service.server.ts", adminState: "PENDING_ADMIN" },
  { label: "Monthly", file: "src/features/planning/monthly-plan.server.ts", adminState: "PENDING_ADMIN" },
  { label: "Recovery", file: "src/features/recovery/approval.server.ts", adminState: "PENDING_ADMIN" },
  { label: "Scheme Planning", file: "src/features/schemes/scheme-planning.server.ts", adminState: "PENDING_APPROVAL" },
];

for (const m of MODULES) {
  test(`${m.label}: submission consults getCurrentManagerId (the RM authority)`, () => {
    const code = stripComments(read(m.file));
    assert.match(code, /getCurrentManagerId\s*\(/, `${m.label} must resolve the RM via getCurrentManagerId`);
  });

  test(`${m.label}: managerId null routes to the admin-pending state, not PENDING_RM`, () => {
    const code = stripComments(read(m.file));
    // A ternary that selects PENDING_RM when a manager exists and the admin state otherwise. We accept either
    // `managerId ? PENDING_RM : <admin>` or the `toRm ? PENDING_RM : <admin>` form (toRm = managerId != null).
    const ternary = new RegExp(
      `(managerId|toRm)\\b[\\s\\S]{0,40}?\\?[\\s\\S]{0,80}?PENDING_RM[\\s\\S]{0,80}?:[\\s\\S]{0,80}?${m.adminState}`,
    );
    assert.match(code, ternary, `${m.label} must map "has RM"→PENDING_RM and "no RM"→${m.adminState}`);
  });
}

test("Scheme Planning: no role-only `isRm ? PENDING_APPROVAL : PENDING_RM` branch remains (the old bug)", () => {
  const code = stripComments(read("src/features/schemes/scheme-planning.server.ts"));
  // The regressed form assigned the forward status directly from isRm (submitter role) with no manager check.
  assert.doesNotMatch(
    code,
    /isRm\s*\?\s*SchemePlanState\.PENDING_APPROVAL\s*:\s*SchemePlanState\.PENDING_RM/,
    "the role-only routing branch must not return",
  );
});

console.log(`\n${passed} RM-routing contract checks passed`);
