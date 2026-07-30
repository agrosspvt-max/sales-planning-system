import { redirect } from "next/navigation";

// Superseded: the read-only workbook is now the in-plan Product Plan + Dealer Summary tabs.
export default function Page() {
  redirect("/planning/sales/plans");
}
