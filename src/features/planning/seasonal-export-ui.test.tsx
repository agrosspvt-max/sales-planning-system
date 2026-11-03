/** Export Seasonal Plan — the button's permission gate (independent of Import), the dialog's guards and the download filename. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Role } from "@prisma/client";
import { ADMIN_MODULES, hasAdminPermission } from "@/features/accounts/permissions";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { downloadFilename } from "./seasonal-export-dialog";

const page = readFileSync("src/features/planning/sales-planning.tsx", "utf8");
const dialog = readFileSync("src/features/planning/seasonal-export-dialog.tsx", "utf8");

// Permission: Sales Planning → Export, a separate grant; Import Seasonal Plan does not imply it (and vice versa).
const sales = ADMIN_MODULES.find((m) => m.id === "salesPlanning")!;
assert.ok((sales.actions as readonly string[]).includes("export"), "Sales Planning has an Export action to grant");
const importOnly = { role: Role.CUSTOM_ADMIN, permissions: { planImport: ["read", "analyze", "import"], salesPlanning: ["read"] } };
assert.equal(hasAdminPermission(importOnly, "salesPlanning", "export"), false, "Import permission never grants export");
assert.equal(hasAdminPermission({ role: Role.CUSTOM_ADMIN, permissions: { salesPlanning: ["read", "export"] } }, "salesPlanning", "export"), true);
assert.equal(hasAdminPermission({ role: Role.SUPER_ADMIN }, "salesPlanning", "export"), true);
assert.equal(hasAdminPermission({ role: Role.SALES_OFFICER }, "salesPlanning", "export"), false);

// Button: beside Import, in BOTH Create New Plan and View Plans, gated on the export grant only (Import stays Create-only, as before).
assert.ok(page.includes('useAdminPermission("salesPlanning", "export")') && page.includes("const canExport = isAdmin && exportGranted;"), "UI gate = administrator + export grant");
assert.ok(page.includes("isAdmin && (isCreate || canExport)") && page.includes("{isCreate && (") && page.includes("{canExport && ("), "Export shows in both modes; Import keeps its Create-only placement");
assert.ok(!/canExport[^\n]*planImport|planImport[^\n]*canExport/.test(page), "export does not depend on the Import grant");
assert.ok(page.includes('useLabel("sales_planning.export.button")') && DEFAULT_LABELS["sales_planning.export.button"] === "Export Seasonal Plan");

// Dialog guards: one request at a time, a version must be chosen, failures are reported (never a silent partial download).
assert.ok(dialog.includes("if (inFlight.current) return;"), "duplicate submissions are ignored");
assert.ok(dialog.includes("disabled={exporting || !seasonId || selectedIds.length === 0}"), "Export is disabled while exporting / without a season / without officers");
assert.ok(dialog.includes("missing.length > 0") && dialog.includes("L.versionRequired"), "every selected officer needs an explicit version");
assert.ok(dialog.includes("disabled={none || exporting}") && dialog.includes("L.noPlan"), "officers without a plan are explained and cannot be selected");
assert.ok(dialog.includes("o.plans.length > 0 && !(o.officerId in next)"), "Select All selects only officers that have a plan to export");
for (const key of Object.keys(DEFAULT_LABELS).filter((k) => k.startsWith("sales_planning.export."))) {
  assert.ok(dialog.includes(`"${key}"`) || page.includes(`"${key}"`), `label ${key} is used`);
}

// The server's filename (UTF-8 aware), with a fallback.
assert.equal(downloadFilename(`attachment; filename="Seasonal Plan - A - Kharif 2026 - v2.xlsx"; filename*=UTF-8''Seasonal%20Plan%20-%20B%C3%A9%20-%20Kharif%202026%20-%20v2.xlsx`, "x"), "Seasonal Plan - Bé - Kharif 2026 - v2.xlsx");
assert.equal(downloadFilename('attachment; filename="Seasonal Plans - Kharif 2026 - 2026-11-03.zip"', "x"), "Seasonal Plans - Kharif 2026 - 2026-11-03.zip");
assert.equal(downloadFilename(null, "Seasonal Plan.xlsx"), "Seasonal Plan.xlsx");

console.log("seasonal-export-ui.test.tsx — all assertions passed");
