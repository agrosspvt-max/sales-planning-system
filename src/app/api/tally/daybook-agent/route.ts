import { handle, ok } from "@/lib/http";
import { daybookAgent } from "@/features/tally/daybook.server";
import { DAYBOOK_PREVIEW_BYTES } from "@/features/tally/daybook-preview";
import { readBody } from "@/features/tally/service.server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  return handle(async () =>
    ok(await daybookAgent(req, await readBody(req, DAYBOOK_PREVIEW_BYTES))),
  );
}
