import { type NextRequest } from "next/server";
import { handle, ok, requireAuth, ApiError } from "@/lib/http";
import { fileToBuffer } from "@/lib/import/workbook";
import { parsePriceWorkbook } from "@/features/import/prices/service.server";

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(422, "No file uploaded");
    const buffer = await fileToBuffer(file);
    return ok(await parsePriceWorkbook(ctx, buffer));
  });
}
