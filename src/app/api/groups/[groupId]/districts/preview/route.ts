import { type NextRequest } from "next/server";
import { ApiError, handle, ok, requireAuth } from "@/lib/http";
import { fileToBuffer } from "@/lib/import/workbook";
import { previewDistrictImport } from "@/features/users/district-master.server";

// POST multipart: file. READ ONLY — nothing is saved.
export async function POST(req: NextRequest, ctx: { params: Promise<{ groupId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { groupId } = await ctx.params;
    const file = (await req.formData()).get("file");
    if (!(file instanceof File)) throw new ApiError(422, "No file uploaded");
    return ok(await previewDistrictImport(auth, groupId, await fileToBuffer(file)));
  });
}
