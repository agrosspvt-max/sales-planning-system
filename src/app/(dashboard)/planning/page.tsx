import { redirect } from "next/navigation";

// Planning now opens on the Create Plan workspace (two-workspace lifecycle:
// Create Plan = work-in-progress drafts, View Plans = approved).
export default function Page() {
  redirect("/planning/create");
}
