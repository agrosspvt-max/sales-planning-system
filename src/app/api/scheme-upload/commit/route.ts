import { type NextRequest } from "next/server";
import { handle, ok, requireAuth, ApiError } from "@/lib/http";
import { fileToBuffer } from "@/lib/import/workbook";
import { commitSchemeUpload } from "@/features/schemes/scheme-upload.server";

/**
 * Scheme Upload — Commit (atomic). Writes ONLY the scheme tracking tables; never MonthlyEntry or any
 * normal Sales Planning actual. A 409 is returned when an exact-range scope exists and replace is not
 * confirmed — the client re-submits with replace=true after the user confirms.
 */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(422, "No file uploaded");
    const dataRaw = form.get("data");
    const data = typeof dataRaw === "string" ? JSON.parse(dataRaw) : {};
    const buffer = await fileToBuffer(file);
    return ok(await commitSchemeUpload(auth, buffer, file.name, data));
  });
}
