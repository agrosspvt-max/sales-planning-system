import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/http";
import { exportMissingAliases } from "@/features/sales-upload/alias.server";

/** Download the "Without Alias" dealers as an .xlsx [Dealer Name, Sales Officer]. */
export async function GET(_req: NextRequest) {
  const auth = await requireAuth();
  const { buffer, filename } = await exportMissingAliases(auth);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
