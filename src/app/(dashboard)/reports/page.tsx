import { auth } from "@/auth";
import { ReportsPage } from "@/features/reports/reports-page";

export default async function Page() {
  await auth();
  return <ReportsPage />;
}
