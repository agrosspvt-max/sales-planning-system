import { auth } from "@/auth";
import { AnnouncementsPage } from "@/features/announcements/announcements-page";

export default async function Page() {
  await auth();
  return <AnnouncementsPage />;
}
