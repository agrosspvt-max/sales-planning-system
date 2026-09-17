import assert from "node:assert/strict";
import { oldestDraftPlanCreatedAt, schemeTypeLabel } from "./scheme-create-plan-summary";
import { formatSchemeDate } from "./utils";

const rows = [
  { dealerId: "A", createdAt: "2026-09-10T08:00:00.000Z" },
  { dealerId: "B", createdAt: "2026-09-12T08:00:00.000Z" },
  { dealerId: "C", createdAt: "2026-09-15T08:00:00.000Z" },
];

assert.equal(oldestDraftPlanCreatedAt(rows), rows[0].createdAt);
assert.equal(oldestDraftPlanCreatedAt(rows.filter((row) => row.dealerId !== "A")), rows[1].createdAt);
assert.equal(oldestDraftPlanCreatedAt(rows.filter((row) => row.dealerId === "C")), rows[2].createdAt);
assert.equal(formatSchemeDate(oldestDraftPlanCreatedAt(rows)), "10/09/2026");
assert.equal(formatSchemeDate(oldestDraftPlanCreatedAt(rows.filter((row) => row.dealerId !== "A"))), "12/09/2026");
assert.equal(formatSchemeDate(oldestDraftPlanCreatedAt(rows.filter((row) => row.dealerId === "C"))), "15/09/2026");
assert.equal(oldestDraftPlanCreatedAt([]), null);
assert.equal(schemeTypeLabel("FIXED"), "Fixed Scheme");
assert.equal(schemeTypeLabel("MULTIPLE_OPTIONS"), "Option Scheme");

console.log("9 Create Plan summary display contracts passed");
