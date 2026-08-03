import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { addSingleAlias } from "@/features/sales-upload/alias.server";

const schema = z.object({ systemDealerId: z.string().min(1), tallyName: z.string().min(1).max(200) });

export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const { systemDealerId, tallyName } = schema.parse(await req.json());
    return ok(await addSingleAlias(auth, systemDealerId, tallyName));
  });
}
