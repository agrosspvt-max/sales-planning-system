import { type NextRequest } from "next/server";
import { ApiError, handle, ok, requireAuth } from "@/lib/http";
import { fileToBuffer } from "@/lib/import/workbook";
import { previewTerritoryImport } from "@/features/party-planning/territory.server";

// POST multipart: file, optional sheet. Read-only: nothing is written.
export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(422, "No file uploaded");
    const sheetValue = form.get("sheet");
    const sheet = typeof sheetValue === "string" && sheetValue ? sheetValue : null;
    const buffer = await fileToBuffer(file);
    return ok(await previewTerritoryImport(ctx, buffer, sheet));
  });
}
