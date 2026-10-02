import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, handle, ok, requireAuth } from "@/lib/http";
import { resolveDealerDisplayNames } from "@/lib/dealer-display-name.server";
export async function GET() {
  return handle(async () => {
    const auth = await requireAuth();
    if (auth.role !== Role.SUPER_ADMIN)
      throw new ApiError(403, "Only the Super Admin can review historical receipts.");
    const dealers = await prisma.dealer.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
    });
    const names = await resolveDealerDisplayNames(dealers);
    return ok(
      dealers
        .map((d) => ({ id: d.id, name: names.get(d.id) ?? d.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  });
}
