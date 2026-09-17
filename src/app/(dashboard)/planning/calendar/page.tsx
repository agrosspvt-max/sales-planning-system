import { auth } from "@/auth";
import { CalendarView } from "@/features/calendar/calendar-view";
import { getCalendarEnabled } from "@/lib/recovery-config";
import { redirect } from "next/navigation";

export default async function Page() {
  const session = await auth();
  if (!(await getCalendarEnabled())) redirect("/dashboard");
  return <CalendarView role={session!.user.role} userId={session!.user.id} />;
}
