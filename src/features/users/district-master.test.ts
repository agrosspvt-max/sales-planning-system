/**
 * District master service (State Catalogue → Districts): Admin-only, per-state, preview never writes, confirm re-validates, re-upload is idempotent,
 * nothing is deleted, no state / group is ever created, every change is audited. Runs the REAL service against an in-memory database.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { Role } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import { apiPermission } from "@/features/accounts/route-permissions";
import { moduleForPage } from "@/features/accounts/permissions";
import { DEFAULT_LABELS, labelMeta, type LabelKey } from "@/features/labels/labels";
import type { AuthContext } from "@/lib/http";

type Row = Record<string, unknown>;
function makeDb() {
  const t = { groups: [{ id: "g1", name: "Madhya Pradesh" }, { id: "g2", name: "Uttar Pradesh" }] as Row[], districts: [] as Row[], aliases: [] as Row[], audit: [] as Row[], groupWrites: 0 };
  let seq = 0;
  const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => (v && typeof v === "object" && "in" in (v as Row) ? ((v as { in: unknown[] }).in).includes(row[k]) : row[k] === v));
  const prisma = {
    userGroup: { findUnique: async ({ where }: { where: Row }) => t.groups.find((g) => matches(g, where)) ?? null, create: async () => { t.groupWrites += 1; throw new Error("groups must never be created"); } },
    district: {
      findMany: async ({ where }: { where?: Row } = {}) => t.districts.filter((d) => matches(d, where)).map((d) => ({ ...d })),
      findFirst: async ({ where }: { where?: Row } = {}) => { const d = t.districts.find((x) => matches(x, where)); return d ? { ...d } : null; },
      create: async ({ data }: { data: Row }) => {
        if (t.districts.some((d) => d.groupId === data.groupId && d.nameKey === data.nameKey)) throw Object.assign(new Error("unique"), { code: "P2002" });
        const row = { id: `d${++seq}`, isActive: true, ...data }; t.districts.push(row); return { ...row };
      },
      update: async ({ where, data }: { where: Row; data: Row }) => { const d = t.districts.find((x) => matches(x, where))!; Object.assign(d, data); return { ...d }; },
    },
    districtAlias: { findMany: async ({ where }: { where?: Row } = {}) => t.aliases.filter((a) => matches(a, where)).map((a) => ({ ...a })) },
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => {
      const snap = structuredClone([t.districts, t.audit]);
      try { return await fn(prisma); } catch (e) { [t.districts, t.audit] = snap as [Row[], Row[]]; throw e; }
    },
  };
  return { prisma, t };
}
function loadService() {
  const db = makeDb();
  const load = testLoader({
    "@/lib/prisma": { prisma: db.prisma },
    "@/lib/http": { ApiError: TestApiError },
    "@/lib/api-error": { ApiError: TestApiError },
    "@/lib/audit": { writeAudit: async (p: Row) => { db.t.audit.push({ ...p }); } },
  });
  return { service: load("src/features/users/district-master.server.ts") as typeof import("./district-master.server"), ...db };
}
const ctx = (role: Role, permissions?: Record<string, string[]>) => ({ userId: `u-${role}`, role, username: String(role), groupId: null, designation: null, permissions } as unknown as AuthContext);
const ADMIN = ctx(Role.SUPER_ADMIN), SO = ctx(Role.SALES_OFFICER), RM = ctx(Role.REGIONAL_MANAGER);
const workbook = (rows: unknown[][], sheet = "Districts") => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet); return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer; };
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
async function status(fn: () => Promise<unknown>) { try { await fn(); return 0; } catch (e) { return (e as { status?: number }).status ?? -1; } }

async function main() {
  const file = workbook([["S.No", "District Name"], [1, "Agar Malwa"], [2, "Alirajpur"], [3, "Anuppur"]]);

  // Authorization: administrative roles only; a custom Admin needs the State Catalogue grant.
  {
    const { service } = loadService();
    for (const who of [SO, RM]) {
      assert.equal(await status(() => service.listDistricts(who, "g1")), 403, `${who.role} cannot list`);
      assert.equal(await status(() => service.previewDistrictImport(who, "g1", file)), 403, `${who.role} cannot preview`);
      assert.equal(await status(() => service.commitDistrictImport(who, "g1", file)), 403, `${who.role} cannot import`);
      assert.equal(await status(() => service.setDistrictActive(who, "g1", "x", { isActive: false })), 403, `${who.role} cannot toggle`);
    }
    const custom = (p: Record<string, string[]>) => ctx(Role.CUSTOM_ADMIN, p);
    assert.equal(await status(() => service.listDistricts(custom({ reports: ["read"] }), "g1")), 403, "a custom Admin without productCatalogue is refused");
    assert.equal(await status(() => service.commitDistrictImport(custom({ productCatalogue: ["read"] }), "g1", file)), 403, "read-only grant cannot import");
    assert.equal(await status(() => service.listDistricts(custom({ productCatalogue: ["read"] }), "g1")), 0, "read grant may view");
    assert.equal(await status(() => service.commitDistrictImport(custom({ productCatalogue: ["read", "create"] }), "g1", file)), 0, "create grant may import");
  }

  // State resolution: the group is the state; an unknown group is refused and nothing is created.
  {
    const { service, t } = loadService();
    assert.equal(await status(() => service.previewDistrictImport(ADMIN, "nope", file)), 404);
    assert.equal(await status(() => service.commitDistrictImport(ADMIN, "nope", file)), 404);
    assert.equal(t.groupWrites, 0); assert.equal(t.groups.length, 2, "no state / group is ever created");
    assert.equal(t.districts.length, 0);
  }

  // Preview writes nothing; commit creates; re-upload is idempotent; nothing is deleted; same name allowed in another state.
  {
    const { service, t } = loadService();
    const before = JSON.stringify([t.districts, t.audit]);
    const preview = plain(await service.previewDistrictImport(ADMIN, "g1", file));
    assert.equal(JSON.stringify([t.districts, t.audit]), before, "preview writes nothing");
    assert.deepEqual([preview.summary!.newCount, preview.summary!.existing, preview.summary!.invalid, preview.groupName, preview.sheet], [3, 0, 0, "Madhya Pradesh", "Districts"]);
    assert.deepEqual(plain(await service.commitDistrictImport(ADMIN, "g1", file)), { created: 3, alreadyThere: 0, inactiveExisting: 0 });
    assert.deepEqual(t.districts.map((d) => [d.groupId, d.name, d.nameKey, d.isActive]), [["g1", "Agar Malwa", "agar malwa", true], ["g1", "Alirajpur", "alirajpur", true], ["g1", "Anuppur", "anuppur", true]]);
    assert.ok(t.audit.some((a) => a.entity === "district" && a.action === "CREATE" && String(a.summary).includes("3 created") && String(a.summary).includes("Madhya Pradesh")), "import audited");

    // idempotent re-import
    const again = plain(await service.commitDistrictImport(ADMIN, "g1", file));
    assert.deepEqual([again.created, again.alreadyThere], [0, 3]);
    assert.equal(t.districts.length, 3, "no duplicates");
    // a later file with only some districts, plus a new one: nothing missing is deleted
    const second = workbook([["S.No", "District Name"], [1, "anuppur"], [2, "Ashoknagar"]]);
    assert.deepEqual(plain(await service.commitDistrictImport(ADMIN, "g1", second)), { created: 1, alreadyThere: 1, inactiveExisting: 0 });
    assert.deepEqual(t.districts.map((d) => d.name), ["Agar Malwa", "Alirajpur", "Anuppur", "Ashoknagar"], "districts absent from the new file stay");
    // the same name in another state is a separate district
    assert.equal(plain(await service.commitDistrictImport(ADMIN, "g2", workbook([["District Name"], ["Anuppur"]]))).created, 1);
    assert.deepEqual(t.districts.filter((d) => d.nameKey === "anuppur").map((d) => d.groupId).sort(), ["g1", "g2"], "unique within a state, repeatable across states");
    // inactive districts are not silently reactivated by a re-upload
    await service.setDistrictActive(ADMIN, "g1", t.districts[0]!.id as string, { isActive: false });
    const inactive = plain(await service.commitDistrictImport(ADMIN, "g1", file));
    assert.deepEqual([inactive.created, inactive.inactiveExisting], [0, 1]);
    assert.equal(t.districts[0]!.isActive, false);
  }

  // Validation: invalid rows are shown and block the whole file; nothing is saved.
  {
    const { service, t } = loadService();
    const bad = workbook([["S.No", "District Name"], [1, "Bhind"], [2, ""], [3, "BHIND"], [4, "Datia"]]);
    const preview = plain(await service.previewDistrictImport(ADMIN, "g1", bad));
    assert.deepEqual(preview.plan.map((r: { rowNumber: number; status: string }) => [r.rowNumber, r.status]), [[2, "NEW"], [3, "INVALID"], [4, "INVALID"], [5, "NEW"]]);
    assert.match(String(preview.plan[1]!.reason), /required/); assert.match(String(preview.plan[2]!.reason), /Duplicate of row 2/);
    assert.equal(await status(() => service.commitDistrictImport(ADMIN, "g1", bad)), 422, "an invalid file is refused whole");
    assert.equal(t.districts.length, 0, "nothing was saved");
    assert.equal((plain(await service.previewDistrictImport(ADMIN, "g1", workbook([["S.No", "Name"], [1, "X"]]))) as { error: string }).error.includes("District Name"), true, "column validation");
    assert.equal(await status(() => service.commitDistrictImport(ADMIN, "g1", workbook([["S.No", "Name"], [1, "X"]]))), 422);
    assert.ok((plain(await service.previewDistrictImport(ADMIN, "g1", Buffer.from("not a workbook"))) as { error: string | null }).error, "a file without the District Name column is reported, not saved");
    // blank rows are ignored; a sheet other than "Districts" is used when it is the only one
    assert.equal(plain(await service.previewDistrictImport(ADMIN, "g1", workbook([["District Name"], [""], ["Dewas"], [null]], "Sheet1"))).summary!.newCount, 1);
  }

  // Activate / deactivate: scoped to the state, audited, idempotent.
  {
    const { service, t } = loadService();
    await service.commitDistrictImport(ADMIN, "g1", file);
    await service.commitDistrictImport(ADMIN, "g2", workbook([["District Name"], ["Agra"]]));
    const mp = t.districts.find((d) => d.name === "Anuppur")!, up = t.districts.find((d) => d.name === "Agra")!;
    const audits = t.audit.length;
    await service.setDistrictActive(ADMIN, "g1", mp.id as string, { isActive: false });
    assert.equal(mp.isActive, false);
    assert.ok(t.audit.some((a) => a.entity === "district" && a.entityId === mp.id && String(a.summary).includes("deactivated")), "deactivation audited");
    await service.setDistrictActive(ADMIN, "g1", mp.id as string, { isActive: false });
    assert.equal(t.audit.length, audits + 1, "no-op toggle writes no audit entry");
    await service.setDistrictActive(ADMIN, "g1", mp.id as string, { isActive: true });
    assert.equal(mp.isActive, true); assert.ok(t.audit.some((a) => String(a.summary).includes("activated")));
    assert.equal(await status(() => service.setDistrictActive(ADMIN, "g1", up.id as string, { isActive: false })), 404, "a district of another state cannot be toggled through this state");
    assert.equal(up.isActive, true);
    assert.equal(await status(() => service.setDistrictActive(ADMIN, "g1", mp.id as string, { isActive: "no" })), 422);
    const list = plain(await service.listDistricts(ADMIN, "g1"));
    assert.deepEqual([list.groupName, list.districts.map((d: { name: string }) => d.name)], ["Madhya Pradesh", ["Agar Malwa", "Alirajpur", "Anuppur"]]);
    // download = same columns as the upload (+ Status)
    const dl = await service.buildDistrictWorkbook(ADMIN, "g1");
    const rows = XLSX.utils.sheet_to_json(XLSX.read(dl.buffer, { type: "buffer" }).Sheets["Districts"]!, { header: 1 }) as unknown[][];
    assert.deepEqual(rows[0], ["S.No", "District Name", "Status"]); assert.equal(rows.length, 4); assert.equal(dl.filename, "Madhya Pradesh_Districts.xlsx");
    assert.equal(await status(() => service.buildDistrictWorkbook(SO, "g1")), 403);
  }

  // Route / page permission wiring and labels.
  {
    assert.deepEqual(apiPermission("/api/groups/g1/districts", "GET"), ["productCatalogue", "read"]);
    assert.deepEqual(apiPermission("/api/groups/g1/districts/preview", "POST"), ["productCatalogue", "create"]);
    assert.deepEqual(apiPermission("/api/groups/g1/districts/import", "POST"), ["productCatalogue", "create"]);
    assert.deepEqual(apiPermission("/api/groups/g1/districts/d9", "PATCH"), ["productCatalogue", "update"]);
    assert.deepEqual(apiPermission("/api/territory-mapping/districts", "GET"), ["partyPlanning", "read"], "dropdown options use the Territory Mapping read grant");
    assert.equal(moduleForPage("/groups/g1/districts"), "productCatalogue");
    const keys = Object.keys(DEFAULT_LABELS).filter((k) => k.startsWith("state_catalogue.districts."));
    assert.ok(keys.length >= 35, `${keys.length} District master labels`);
    assert.ok(keys.every((k) => labelMeta(k as LabelKey).module === "State Catalogue"), "District master labels appear under State Catalogue in Edit Labels");
    const page = readFileSync("src/features/users/district-master-page.tsx", "utf8"), src = readFileSync("src/features/users/district-master-page.tsx", "utf8") + readFileSync("src/features/users/product-catalogue-page.tsx", "utf8");
    for (const k of keys) assert.ok(src.includes(`"${k}"`), `label used: ${k}`);
    assert.ok(page.includes("canConfirm") && page.includes("preview.summary.invalid === 0"), "Confirm is disabled while any row is invalid");
    assert.ok(readFileSync("src/features/users/product-catalogue-page.tsx", "utf8").includes("/groups/${groupId}/districts"), "State Catalogue links to its Districts page");
  }
  console.log("district-master.test.ts — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
