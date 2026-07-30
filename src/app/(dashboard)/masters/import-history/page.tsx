import { Role } from "@prisma/client";
import { auth } from "@/auth";
import { Forbidden } from "@/components/layout/forbidden";
import { ImportHistoryPage } from "@/features/import/dealers/history-page";

export default async function Page() {
  const session = await auth();
  if (session!.user.role !== Role.SUPER_ADMIN) return <Forbidden />;
  return <ImportHistoryPage />;
}
