import { handle, ok } from "@/lib/http";
import { readBody } from "@/features/tally/service.server";
import { salesAgent } from "@/features/tally/sales.server";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(req: Request) {
  return handle(async () => ok(await salesAgent(req, await readBody(req))));
}
