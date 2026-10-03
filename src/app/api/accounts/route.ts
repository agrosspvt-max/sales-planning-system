import { handle, ok, requireAuth } from "@/lib/http";
import { createAccount, listAccounts } from "@/features/accounts/service.server";
export async function GET() { return handle(async () => ok(await listAccounts(await requireAuth()))); }
export async function POST(req: Request) { return handle(async () => ok(await createAccount(await requireAuth(), await req.json()), 201)); }
