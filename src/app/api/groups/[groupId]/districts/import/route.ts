import { type NextRequest } from "next/server";
import { ApiError, handle, ok, requireAuth } from "@/lib/http";
import { fileToBuffer } from "@/lib/import/workbook";
import { commitDistrictImport } from "@/features/users/district-master.server";

// POST multipart: file. Re-parses and re-validates the file, then adds the NEW districts of this state in one transaction.
export async function POST(req: NextRequest, ctx: { params: Promise<{ groupId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { groupId } = await ctx.params;
    const file = (await req.formData()).get("file");
    if (!(file instanceof File)) throw new ApiError(422, "No file uploaded");
    return ok(await commitDistrictImport(auth, groupId, await fileToBuffer(file)));
  });
}
