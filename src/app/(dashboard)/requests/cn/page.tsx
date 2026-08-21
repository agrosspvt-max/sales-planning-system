import { auth } from "@/auth";
import { CnRequestsPage } from "@/features/cn-requests/cn-requests-page";

export default async function Page() {
  const session = await auth();
  return <CnRequestsPage role={session!.user.role} userId={session!.user.id} />;
}
