import { type NextRequest } from "next/server";
import { handle, ok, requireAuth, ApiError } from "@/lib/http";
import { fileToBuffer } from "@/lib/import/workbook";
import { createRecoveryFromAging } from "@/features/recovery/service.server";

export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(422, "No file uploaded");
    const dataRaw = form.get("data");
    const data = typeof dataRaw === "string" ? JSON.parse(dataRaw) : {};
    return ok(await createRecoveryFromAging(auth, await fileToBuffer(file), file.name, data));
  });
}
