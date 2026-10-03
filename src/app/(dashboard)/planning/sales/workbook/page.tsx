import { auth } from "@/auth";
import { redirect } from "next/navigation";

// Superseded: the read-only workbook is now the in-plan Product Plan + Dealer Summary tabs.
export default async function Page() {
  await auth();
  redirect("/planning/sales/plans");
}
