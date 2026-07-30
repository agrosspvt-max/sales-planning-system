import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { resolveDealers } from "@/features/import/dealers/service.server";

const schema = z.object({ names: z.array(z.string()) });

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const { names } = schema.parse(await req.json());
    return ok(await resolveDealers(ctx, names));
  });
}
