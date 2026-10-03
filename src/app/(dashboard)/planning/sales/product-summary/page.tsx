import { auth } from "@/auth";
import { redirect } from "next/navigation";

// Superseded: Product Plan is now an in-plan tab. Cross-plan analysis lives under Reports.
export default async function Page() {
  await auth();
  redirect("/planning/sales/plans");
}
