import { auth } from "@/auth";
import { DailyWorkPage } from "@/features/daily-work/daily-work-page";

// Daily Work Template (Sales + Recovery). A Sales Officer's daily execution page; the server enforces who
// may save/submit and scopes every dealer to the caller's own assigned dealers.
export default async function Page() {
  const session = await auth();
  return <DailyWorkPage role={session!.user.role} />;
}
