import { auth } from "@/auth";
import { NotificationsPage } from "@/features/notifications/notifications-page";

export default async function Page() {
  await auth();
  return <NotificationsPage />;
}
