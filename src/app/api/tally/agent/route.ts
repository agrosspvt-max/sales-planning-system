import { handle, ok } from "@/lib/http";
import { agent, readBody } from "@/features/tally/service.server";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(req: Request) {
  return handle(async () => ok(await agent(req, await readBody(req))));
}
