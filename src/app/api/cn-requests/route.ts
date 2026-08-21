import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { createCnRequest, listCnRequests } from "@/features/cn-requests/service.server";

export async function GET(_req: NextRequest) {
  return handle(async () => ok(await listCnRequests(await requireAuth())));
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await createCnRequest(auth, await req.json()));
  });
}
