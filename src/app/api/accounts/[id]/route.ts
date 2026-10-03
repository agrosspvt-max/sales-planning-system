import { handle, ok, requireAuth } from "@/lib/http";
import { editAccount } from "@/features/accounts/service.server";
export async function PATCH(req: Request, route: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await editAccount(await requireAuth(), (await route.params).id, await req.json())));
}
