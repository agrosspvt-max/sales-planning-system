import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { createCnRequest, listCnRequests } from "@/features/cn-requests/service.server";
import { isCnRequestView } from "@/lib/cn-request";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const rawView = req.nextUrl.searchParams.get("view");
    return ok(await listCnRequests(await requireAuth(), isCnRequestView(rawView) ? rawView : undefined));
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await createCnRequest(auth, await req.json()));
  });
}
