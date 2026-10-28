import { handle, ok, requireAuth } from "@/lib/http";
import { assertEnabled, sameOrigin, setup, disable } from "@/features/tally/service.server";
export async function POST(req: Request) {
  return handle(async () => {
    assertEnabled();
    sameOrigin(req);
    return ok(await setup(await requireAuth()));
  });
}

export async function DELETE(req: Request) {
  return handle(async () => {
    assertEnabled();
    sameOrigin(req);
    return ok(await disable(await requireAuth()));
  });
}
