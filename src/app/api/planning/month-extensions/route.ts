import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import {
  listMonthExtensionRequests,
  requestMonthExtension,
} from "@/features/planning/month-extension.server";

const createSchema = z.object({
  seasonId: z.string().min(1),
  monthName: z.string().min(1).max(60),
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const status = req.nextUrl.searchParams.get("status") ?? undefined;
    return ok(await listMonthExtensionRequests(auth, status));
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const { seasonId, monthName } = createSchema.parse(await req.json());
    return ok(await requestMonthExtension(auth, seasonId, monthName));
  });
}
