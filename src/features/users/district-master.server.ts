import "server-only";
import * as XLSX from "xlsx";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { isAdministrativeRole, assertAdminPermission } from "@/features/accounts/permissions";
import { readWorkbook, sheetNames } from "@/lib/import/workbook";
import {
  cleanDistrictName, districtKey, parseDistrictSheet, planDistrictImport, summarizeDistrictImport,
  type DistrictImportRow, type DistrictImportSummary,
} from "@/lib/district-master";

/**
 * District master (State Catalogue → Districts). A State is the existing UserGroup — the same group whose State Catalogue page this is — so a
 * district is created under the group it was uploaded for; no state or group is ever created here. Districts are unique within a state after
 * normalization, are never deleted (an upload only ADDS; missing ones are untouched) and can be switched active / inactive.
 * Authorization: administrative roles only, with the State Catalogue (`productCatalogue`) grant for a custom Admin.
 */

type Action = "read" | "create" | "update";
function assertDistrictAdmin(ctx: AuthContext, action: Action): void {
  if (!isAdministrativeRole(ctx.role)) throw new ApiError(403, "Only an Admin can manage districts");
  assertAdminPermission(ctx, "productCatalogue", action);
}
async function loadGroupOr404(groupId: string) {
  const group = await prisma.userGroup.findUnique({ where: { id: groupId }, select: { id: true, name: true } });
  if (!group) throw new ApiError(404, "State not found");
  return group;
}

export interface DistrictDto { id: string; name: string; isActive: boolean; aliases: string[] }
export async function listDistricts(ctx: AuthContext, groupId: string): Promise<{ groupId: string; groupName: string; districts: DistrictDto[] }> {
  assertDistrictAdmin(ctx, "read");
  const group = await loadGroupOr404(groupId);
  const [districts, aliases] = await Promise.all([
    prisma.district.findMany({ where: { groupId }, select: { id: true, name: true, isActive: true } }),
    prisma.districtAlias.findMany({ where: { groupId }, select: { districtId: true, alias: true } }),
  ]);
  return {
    groupId, groupName: group.name,
    districts: [...districts].sort((a, b) => a.name.localeCompare(b.name)).map((d) => ({ ...d, aliases: aliases.filter((a) => a.districtId === d.id).map((a) => a.alias).sort() })),
  };
}

/** The state's district list as .xlsx — same columns as the upload (`S.No`, `District Name`) plus Status, so a download can be re-uploaded as is. */
export async function buildDistrictWorkbook(ctx: AuthContext, groupId: string): Promise<{ buffer: Buffer; filename: string }> {
  assertDistrictAdmin(ctx, "read");
  const { groupName, districts } = await listDistricts(ctx, groupId);
  const ws = XLSX.utils.aoa_to_sheet([["S.No", "District Name", "Status"], ...districts.map((d, i) => [i + 1, d.name, d.isActive ? "Active" : "Inactive"])]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Districts");
  return { buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer, filename: `${groupName}_Districts.xlsx` };
}

/* ------------------------------------------------ upload: preview → confirm ------------------------------------------------ */

export interface DistrictImportPreview { groupName: string; sheet: string | null; error: string | null; plan: DistrictImportRow[]; summary: DistrictImportSummary | null }
const MAX_DISTRICT_ROWS = 1000;

/** Parse + plan — READ ONLY. Both Preview and Confirm run exactly this. */
async function planFromWorkbook(groupId: string, buffer: Buffer): Promise<DistrictImportPreview & { error: string | null }> {
  const group = await loadGroupOr404(groupId);
  let workbook;
  try { workbook = readWorkbook(buffer); } catch { throw new ApiError(422, "The file could not be read as an Excel workbook"); }
  const names = sheetNames(workbook);
  if (names.length === 0) throw new ApiError(422, "The workbook has no sheets");
  const sheet = names.find((n) => n.trim().toLowerCase() === "districts") ?? names[0]!;
  const parsed = parseDistrictSheet(XLSX.utils.sheet_to_json(workbook.Sheets[sheet]!, { header: 1, blankrows: true, defval: null }) as unknown[][]);
  if (parsed.error) return { groupName: group.name, sheet, error: parsed.error, plan: [], summary: null };
  if (parsed.rows.length + parsed.invalid.length > MAX_DISTRICT_ROWS) throw new ApiError(422, `A district list can have at most ${MAX_DISTRICT_ROWS} rows`);
  const [existing, aliases] = await Promise.all([
    prisma.district.findMany({ where: { groupId }, select: { id: true, name: true, nameKey: true, isActive: true } }),
    prisma.districtAlias.findMany({ where: { groupId }, select: { aliasKey: true, districtId: true } }),
  ]);
  const nameById = new Map(existing.map((d) => [d.id, d.name]));
  const plan = planDistrictImport(parsed, existing, new Map(aliases.map((a) => [a.aliasKey, nameById.get(a.districtId) ?? ""])));
  return { groupName: group.name, sheet, error: null, plan, summary: summarizeDistrictImport(plan) };
}

export async function previewDistrictImport(ctx: AuthContext, groupId: string, buffer: Buffer): Promise<DistrictImportPreview> {
  assertDistrictAdmin(ctx, "create");
  return planFromWorkbook(groupId, buffer);
}

export interface DistrictImportResult { created: number; alreadyThere: number; inactiveExisting: number }
/**
 * Confirm: re-parses and re-plans the uploaded file (the browser's preview is never trusted). A file with any invalid row is refused whole —
 * nothing is saved. Only NEW districts are created (a re-upload therefore creates nothing); existing ones are left exactly as they are,
 * including inactive ones, and districts absent from the file are never removed.
 */
export async function commitDistrictImport(ctx: AuthContext, groupId: string, buffer: Buffer): Promise<DistrictImportResult> {
  assertDistrictAdmin(ctx, "create");
  const preview = await planFromWorkbook(groupId, buffer);
  if (preview.error) throw new ApiError(422, preview.error);
  if (preview.summary!.invalid > 0) throw new ApiError(422, "The file has invalid rows. Fix them and upload again — nothing was saved.");
  const fresh = preview.plan.filter((r) => r.status === "NEW");
  const result: DistrictImportResult = { created: 0, alreadyThere: preview.plan.filter((r) => r.status === "EXISTS").length, inactiveExisting: preview.summary!.inactiveExisting };
  if (fresh.length === 0) return result;
  await prisma.$transaction(async (tx) => {
    const have = new Set((await tx.district.findMany({ where: { groupId }, select: { nameKey: true } })).map((d) => d.nameKey)); // re-read: another upload may have added some
    for (const row of fresh) {
      const nameKey = districtKey(row.name);
      if (have.has(nameKey)) { result.alreadyThere += 1; continue; }
      await tx.district.create({ data: { groupId, name: cleanDistrictName(row.name), nameKey, isActive: true, createdById: ctx.userId } });
      have.add(nameKey); result.created += 1;
    }
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "CREATE", entity: "district", entityId: groupId, summary: `${preview.groupName} district list upload: ${result.created} created, ${result.alreadyThere} already present${result.created ? ` (${fresh.slice(0, 30).map((r) => r.name).join(", ")}${fresh.length > 30 ? ", …" : ""})` : ""}` }, tx);
  }, { timeout: 30_000 });
  return result;
}

/* ------------------------------------------------ activate / deactivate ------------------------------------------------ */

const activeInput = z.object({ isActive: z.boolean() });
/** Switch one district of this state active / inactive. Dealers already using it keep it; it just leaves (or returns to) the dropdown. */
export async function setDistrictActive(ctx: AuthContext, groupId: string, districtId: string, raw: unknown): Promise<DistrictDto> {
  assertDistrictAdmin(ctx, "update");
  const parsed = activeInput.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, "isActive (true / false) is required");
  const group = await loadGroupOr404(groupId);
  const district = await prisma.district.findFirst({ where: { id: districtId, groupId }, select: { id: true, name: true, isActive: true } });
  if (!district) throw new ApiError(404, "District not found in this state");
  if (district.isActive === parsed.data.isActive) return { id: district.id, name: district.name, isActive: district.isActive, aliases: [] };
  await prisma.$transaction(async (tx) => {
    await tx.district.update({ where: { id: districtId }, data: { isActive: parsed.data.isActive } });
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "district", entityId: districtId, summary: `${group.name} district "${district.name}" ${parsed.data.isActive ? "activated" : "deactivated"}` }, tx);
  });
  return { id: district.id, name: district.name, isActive: parsed.data.isActive, aliases: [] };
}
