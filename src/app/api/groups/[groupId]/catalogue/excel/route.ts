import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { buildCatalogueWorkbook, importCatalogueExcel } from "@/features/users/catalogue.server";

/** Download the group's catalogue as .xlsx. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ groupId: string }> }) {
  const auth = await requireAuth();
  const { groupId } = await ctx.params;
  const { buffer, filename } = await buildCatalogueWorkbook(auth, groupId);
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

/** Upload a catalogue workbook (multipart). `createMissingMaster=true` confirms CASE 3 (create Master + entry). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ groupId: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { groupId } = await ctx.params;
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("No file uploaded");
    const createMissingMaster = String(form.get("createMissingMaster") ?? "") === "true";
    const buffer = Buffer.from(await file.arrayBuffer());
    return ok(await importCatalogueExcel(auth, groupId, buffer, createMissingMaster));
  });
}
