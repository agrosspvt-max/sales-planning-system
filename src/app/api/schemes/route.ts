import { NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { createScheme, listSchemes } from "@/features/schemes/scheme-master.server";

export async function GET(req: NextRequest) {
  return handle(async () => ok(await listSchemes(await requireAuth(), { status: req.nextUrl.searchParams.get("status"), stateId: req.nextUrl.searchParams.get("state") })));
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await createScheme(auth, await req.json()), 201);
  });
}
