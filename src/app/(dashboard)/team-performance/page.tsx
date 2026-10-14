import { redirect } from "next/navigation";

// Team Performance was merged into Performance (an RM's own rows + their team). Old links and bookmarks keep working.
export default function Page() {
  redirect("/performance");
}
