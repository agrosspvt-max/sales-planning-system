import "server-only";
import { isAdministrativeRole } from "@/features/accounts/permissions";

import type { NextRequest } from "next/server";
import { ApiError, handle, ok, requireAuth } from "@/lib/http";
import { fileToBuffer } from "@/lib/import/workbook";
import { MAX_FILE_BYTES } from "./parser";
import { analyzeHistoricalDaybook, commitHistoricalDaybook } from "./service.server";

export function historicalUpload(req: NextRequest, commit: boolean) {
  return handle(async () => {
    const auth = await requireAuth();
    if (!isAdministrativeRole(auth.role))
      throw new ApiError(403, "Only the Super Admin can import historical Day Book receipts.");
    const form = await req.formData(),
      file = form.get("file");
    if (!(file instanceof File) || !/\.xlsx$/i.test(file.name))
      throw new ApiError(422, "Upload a Day Book .xlsx file.");
    if (file.size > MAX_FILE_BYTES) throw new ApiError(422, "Day Book must be at most 25 MB.");
    let data: unknown;
    try {
      data = JSON.parse(String(form.get("data") ?? "{}"));
    } catch {
      throw new ApiError(422, "Invalid import review data.");
    }
    return ok(
      await (commit ? commitHistoricalDaybook : analyzeHistoricalDaybook)(
        auth,
        await fileToBuffer(file),
        file.name,
        data,
      ),
    );
  });
}
