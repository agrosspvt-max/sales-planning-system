import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getLabelState, setLabelOverride } from "@/features/labels/service.server";

/** GET → { overrides, canEdit }. All authenticated users read; only Super Admin sees canEdit=true. */
export async function GET() {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await getLabelState(auth));
  });
}

/** PATCH → set/clear one label override (Super Admin only). Returns the full override map. */
export async function PATCH(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const body = await req.json();
    return ok({ overrides: await setLabelOverride(auth, body) });
  });
}
