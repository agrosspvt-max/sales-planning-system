import { type NextRequest } from "next/server";
import { handle, ok, requireAuth, ApiError } from "@/lib/http";
import { fileToBuffer } from "@/lib/import/workbook";
import { importDealerAliases, listDealerAliases } from "@/features/sales-upload/alias.server";

export async function GET(_req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await listDealerAliases(auth));
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(422, "No file uploaded");
    const buffer = await fileToBuffer(file);
    return ok(await importDealerAliases(auth, buffer));
  });
}
