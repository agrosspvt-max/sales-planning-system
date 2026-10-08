/** Pure Seasonal Plan rules: derived Type/Status, routing, review transitions, approval ≠ appointment. */
import assert from "node:assert/strict";
import { filterSeasonalRows, canReviewNow, seasonalSheetStatus, applyAppointment, derivedType, displayStatus, finalApprovalFields, isEditable, reviewTransition, shownMarketPotential, shownMarketSource, submitTarget, validatePartyName } from "./seasonal-plan";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

test("Type is derived from the Market's origin: imported = Existing, approved Add Market = New", () => {
  assert.equal(derivedType("EXISTING"), "Existing");
  assert.equal(derivedType("REQUESTED"), "New");
  assert.equal(derivedType(null), null);
  assert.equal(derivedType("anything-else"), null);
});

test("Status is — until final approval, then Pending; Appointed only from the appointment event", () => {
  assert.equal(displayStatus({ appointmentStatus: null }), "—");
  assert.equal(displayStatus({ appointmentStatus: "PENDING" }), "Pending");
  assert.equal(displayStatus({ appointmentStatus: "APPOINTED" }), "Appointed");
});

test("Party Name: required, trimmed, bounded", () => {
  assert.equal(validatePartyName("ABC Traders"), null);
  for (const bad of ["", "   ", null, undefined, 5, "x".repeat(201)]) assert.ok(validatePartyName(bad), String(bad));
});

test("only draft / rejected plans are editable by their owner", () => {
  for (const s of ["DRAFT", "REJECTED"]) assert.equal(isEditable(s), true);
  for (const s of ["PENDING_RM", "PENDING_ADMIN", "APPROVED"]) assert.equal(isEditable(s), false);
});

test("submit routing: an SO with an RM → RM first; an RM (or an SO without an RM) → Admin; submitted plans cannot be re-submitted", () => {
  assert.equal(submitTarget("DRAFT", "SALES_OFFICER", true), "PENDING_RM");
  assert.equal(submitTarget("REJECTED", "SALES_OFFICER", true), "PENDING_RM");
  assert.equal(submitTarget("DRAFT", "SALES_OFFICER", false), "PENDING_ADMIN");
  assert.equal(submitTarget("DRAFT", "REGIONAL_MANAGER", false), "PENDING_ADMIN");
  assert.equal(submitTarget("DRAFT", "REGIONAL_MANAGER", true), "PENDING_ADMIN", "an RM's own plan never goes to an RM");
  for (const s of ["PENDING_RM", "PENDING_ADMIN", "APPROVED"]) assert.equal(submitTarget(s, "SALES_OFFICER", true), null);
});

test("review steps: RM then Admin, a reason for every rejection, no skipping", () => {
  assert.deepEqual(reviewTransition("PENDING_RM", { by: "RM", action: "approve" }), { ok: true, approvalStatus: "PENDING_ADMIN", finalApproval: false });
  assert.deepEqual(reviewTransition("PENDING_ADMIN", { by: "ADMIN", action: "approve" }), { ok: true, approvalStatus: "APPROVED", finalApproval: true });
  assert.deepEqual(reviewTransition("PENDING_RM", { by: "RM", action: "reject", reason: "no" }), { ok: true, approvalStatus: "REJECTED", finalApproval: false });
  for (const by of ["RM", "ADMIN"] as const) {
    const cur = by === "RM" ? "PENDING_RM" : "PENDING_ADMIN";
    for (const reason of [undefined, "", "   "]) assert.deepEqual(reviewTransition(cur, { by, action: "reject", reason }), { ok: false, code: 422, message: "A rejection reason is required." });
  }
  assert.equal(reviewTransition("PENDING_RM", { by: "ADMIN", action: "approve" }).ok, false, "Admin cannot skip the RM step");
  assert.equal(reviewTransition("PENDING_ADMIN", { by: "RM", action: "approve" }).ok, false);
  for (const s of ["DRAFT", "APPROVED", "REJECTED"]) { assert.equal(reviewTransition(s, { by: "RM", action: "approve" }).ok, false); assert.equal(reviewTransition(s, { by: "ADMIN", action: "approve" }).ok, false); }
});

test("final approval makes the plan Pending — it is never Appointed and sets no date", () => {
  const fields = finalApprovalFields({ source: "REQUESTED", potential: "A" });
  assert.deepEqual(fields, { appointmentStatus: "PENDING", appointedAt: null, approvedMarketSource: "REQUESTED", approvedMarketPotential: "A" });
  assert.equal(displayStatus(fields), "Pending");
});

test("the future appointment transition needs an approved, Pending plan and records the date only then", () => {
  assert.deepEqual(applyAppointment({ approvalStatus: "APPROVED", appointmentStatus: "PENDING" }, "2026-10-09"), { appointmentStatus: "APPOINTED", appointedAt: "2026-10-09" });
  assert.equal(applyAppointment({ approvalStatus: "PENDING_ADMIN", appointmentStatus: null }, "2026-10-09"), null, "an unapproved plan cannot be Appointed");
  assert.equal(applyAppointment({ approvalStatus: "APPROVED", appointmentStatus: "APPOINTED" }, "2026-10-09"), null, "already Appointed");
  assert.equal(applyAppointment({ approvalStatus: "APPROVED", appointmentStatus: "PENDING" }, "not-a-date"), null);
});

test("an approved plan keeps the Market values Admin approved; before approval it follows the Market master", () => {
  const market = { source: "EXISTING", potential: "C" };
  assert.equal(shownMarketPotential({ approvalStatus: "PENDING_ADMIN", approvedMarketPotential: null }, market), "C");
  assert.equal(shownMarketPotential({ approvalStatus: "APPROVED", approvedMarketPotential: "A" }, market), "A");
  assert.equal(shownMarketPotential({ approvalStatus: "APPROVED", approvedMarketPotential: null }, market), null, "approved while undecided stays undecided");
  assert.equal(shownMarketSource({ approvalStatus: "APPROVED", approvedMarketSource: "REQUESTED" }, market), "REQUESTED");
  assert.equal(shownMarketSource({ approvalStatus: "DRAFT", approvedMarketSource: null }, market), "EXISTING");
});

test("a Seasonal Plan's list status is derived from its rows (approval itself stays row-level)", () => {
  const rows = (...s: string[]) => s.map((approvalStatus) => ({ approvalStatus }));
  assert.equal(seasonalSheetStatus([]), "Draft", "a freshly created plan is an empty Draft");
  assert.equal(seasonalSheetStatus(rows("DRAFT", "DRAFT")), "Draft");
  assert.equal(seasonalSheetStatus(rows("APPROVED", "APPROVED")), "Approved");
  assert.equal(seasonalSheetStatus(rows("APPROVED", "PENDING_RM")), "Pending Approval");
  assert.equal(seasonalSheetStatus(rows("DRAFT", "PENDING_ADMIN")), "Pending Approval");
  assert.equal(seasonalSheetStatus(rows("APPROVED", "REJECTED")), "Needs Changes");
  assert.equal(seasonalSheetStatus(rows("REJECTED", "PENDING_RM")), "Pending Approval", "something still under review wins");
  assert.equal(seasonalSheetStatus(rows("APPROVED", "DRAFT")), "Draft", "approved + a draft row is still being worked on");
});

test("who can approve / reject a row right now (the review queue that replaced the 'To review' tab)", () => {
  const row = (approvalStatus: string, ownerId = "so1") => ({ approvalStatus, ownerId });
  const rm = { userId: "rm1", role: "RM" as const, teamIds: ["rm1", "so1", "so2"] };
  assert.equal(canReviewNow(row("PENDING_RM"), rm), true);
  assert.equal(canReviewNow(row("PENDING_RM", "so9"), rm), false, "not the RM's team");
  assert.equal(canReviewNow(row("PENDING_RM", "rm1"), rm), false, "never their own row");
  assert.equal(canReviewNow(row("PENDING_ADMIN"), rm), false, "the RM step is over");
  assert.equal(canReviewNow(row("PENDING_ADMIN"), { userId: "a", role: "ADMIN" }), true);
  assert.equal(canReviewNow(row("PENDING_RM"), { userId: "a", role: "ADMIN" }), false, "Admin cannot skip the RM step");
  assert.equal(canReviewNow(row("PENDING_ADMIN"), { userId: "so1", role: "OTHER" }), false);
});

console.log(`\n${passed} seasonal-plan rule tests passed`);

test("detail-page column filters: Market contains (case-insensitive) AND Potential A/B/C", () => {
  const rows = [{ marketName: "Pipariya", marketPotential: "A" }, { marketName: "Pip Nagar", marketPotential: "B" }, { marketName: "Bareli", marketPotential: null }];
  assert.equal(filterSeasonalRows(rows, { market: "", potential: "" }).length, 3);
  assert.equal(filterSeasonalRows(rows, { market: " PIP ", potential: "" }).length, 2);
  assert.deepEqual(filterSeasonalRows(rows, { market: "pip", potential: "A" }).map((r) => r.marketName), ["Pipariya"]);
  assert.equal(filterSeasonalRows(rows, { market: "", potential: "C" }).length, 0);
  assert.equal(filterSeasonalRows(rows, { market: "", potential: "Z" }).length, 3, "arbitrary potentials are ignored");
});
