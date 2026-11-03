import { type NextRequest, NextResponse } from "next/server";
import { handle, ok, requireAuth, ApiError } from "@/lib/http";
import { exportSeasonalPlans, listSeasonalExportOptions } from "@/features/planning/seasonal-export.server";

export const maxDuration = 300; // seconds — a batch of large plans is generated in one request

/** GET ?seasonId= — the officers and their seasonal plan versions in that OPEN season (administrators with the Sales Planning export grant). */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await listSeasonalExportOptions(auth, req.nextUrl.searchParams.get("seasonId") ?? ""));
  });
}

/** POST { seasonId, plans: [{ officerId, planId }] } — one .xlsx (one officer) or one .zip with one .xlsx per officer. Read-only. */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const file = await exportSeasonalPlans(auth, await req.json().catch(() => ({})));
    return new NextResponse(new Uint8Array(file.data), {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="${file.filename.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "X-Export-Officers": String(file.officers),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error(error);
    return NextResponse.json({ error: "The seasonal plan export failed. Nothing was exported." }, { status: 500 });
  }
}
