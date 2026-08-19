import { type NextRequest } from "next/server";
import { signIn } from "@/auth";

/**
 * TEMPORARY ADMIN BYPASS - REMOVE AFTER TESTING
 *
 * Hidden, unlinked route. Opening it signs in as the Super Admin (via the isolated "admin-bypass" auth
 * provider) and redirects to the dashboard — producing a NORMAL Super Admin session with identical
 * permissions/role checks. It is gated by TEMP_ADMIN_BYPASS:
 *   - TEMP_ADMIN_BYPASS=true  → mints the session and redirects to /dashboard.
 *   - otherwise               → returns 404 ("Access disabled"), no session created.
 *
 * This does NOT touch the /login page or the normal credentials flow (Sales Officer / RM / admin logins
 * are unchanged). To remove: delete this file, the "admin-bypass" provider in src/auth.ts, and the
 * /admin-access whitelist line in src/auth.config.ts.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  if (process.env.TEMP_ADMIN_BYPASS !== "true") {
    return new Response("Access disabled", { status: 404 });
  }
  // signIn issues a redirect (throws NEXT_REDIRECT) after setting the session cookie.
  await signIn("admin-bypass", { redirectTo: "/dashboard" });
  // Unreachable fallback so the handler is typed as returning a Response.
  return new Response(null, { status: 302, headers: { Location: "/dashboard" } });
}
