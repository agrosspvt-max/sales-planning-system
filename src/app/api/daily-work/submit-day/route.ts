import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { submitDailyWorkDay } from "@/features/daily-work/service.server";
import { currentBusinessDate } from "@/lib/daily-work";

// POST /api/daily-work/submit-day — freeze the current complete planning batch and rotate to a fresh editor.
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await submitDailyWorkDay(auth, { ...await req.json(), workDate: currentBusinessDate() }));
  });
}
