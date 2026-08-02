import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/http";
import { buildAliasSampleWorkbook } from "@/features/sales-upload/alias.server";

export async function GET(_req: NextRequest) {
  await requireAuth();
  const buffer = buildAliasSampleWorkbook();
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="dealer-alias-sample.xlsx"',
    },
  });
}
