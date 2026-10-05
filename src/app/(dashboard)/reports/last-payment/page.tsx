import { auth } from "@/auth";
import { LastPaymentReportPage } from "@/features/reports/last-payment-report-page";

export default async function Page() {
  await auth();
  return <LastPaymentReportPage />;
}
