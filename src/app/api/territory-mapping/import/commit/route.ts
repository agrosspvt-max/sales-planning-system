import { type NextRequest } from "next/server";
import { ApiError, handle, ok, requireAuth } from "@/lib/http";
import { fileToBuffer } from "@/lib/import/workbook";
import { commitTerritoryImport } from "@/features/party-planning/territory.server";

// POST multipart: file, optional sheet, resolutions (JSON rowNumber → dealerId). Re-parses the file and applies it in one transaction.
export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(422, "No file uploaded");
    const sheetValue = form.get("sheet");
    const sheet = typeof sheetValue === "string" && sheetValue ? sheetValue : null;
    let resolutions: Record<number, string> = {};
    const rawResolutions = form.get("resolutions");
    if (typeof rawResolutions === "string" && rawResolutions) {
      try { resolutions = JSON.parse(rawResolutions) as Record<number, string>; } catch { throw new ApiError(422, "Invalid resolutions"); }
    }

    const buffer = await fileToBuffer(file);
    return ok(await commitTerritoryImport(ctx, buffer, sheet, resolutions));
  });
}
