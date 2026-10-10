import { type NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { buildDistrictWorkbook, listDistricts } from "@/features/users/district-master.server";

/** GET → the state's districts (JSON); GET ?format=xlsx → the same list as a download. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ groupId: string }> }) {
  if (req.nextUrl.searchParams.get("format") === "xlsx") {
    return handle(async () => {
      const auth = await requireAuth();
      const { groupId } = await ctx.params;
      const { buffer, filename } = await buildDistrictWorkbook(auth, groupId);
      return new NextResponse(new Uint8Array(buffer), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${filename}"` } });
    });
  }
  return handle(async () => { const { groupId } = await ctx.params; return ok(await listDistricts(await requireAuth(), groupId)); });
}
