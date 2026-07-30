import { redirect } from "next/navigation";

// Superseded: Dealer Summary is now an in-plan tab. Cross-plan analysis lives under Reports.
export default function Page() {
  redirect("/planning/sales/plans");
}
