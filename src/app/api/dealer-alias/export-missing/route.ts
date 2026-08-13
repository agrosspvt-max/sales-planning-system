import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/http";
import { exportMissingAliases } from "@/features/sales-upload/alias.server";

/** Download the "Without Alias" dealers as an .xlsx [Dealer Name, Sales Officer]. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  const groupId = req.nextUrl.searchParams.get("group") || undefined;
  const officerId = req.nextUrl.searchParams.get("officer") || undefined;
  const { buffer, filename } = await exportMissingAliases(auth, groupId, officerId);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
