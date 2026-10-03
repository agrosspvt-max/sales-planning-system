import { handle, ok, requireAuth } from "@/lib/http";
/** Current-user presentation metadata only; never a substitute for server authorization. */
export async function GET() {
  return handle(async () => {
    const ctx = await requireAuth();
    return ok({ role: ctx.role, designation: ctx.designation, permissions: ctx.permissions });
  });
}
