import { redirect } from "next/navigation";

// Territory Mapping moved out of Party Planning to /planning/territory-mapping. This URL stays valid for bookmarks and old links.
export default function Page() {
  redirect("/planning/territory-mapping");
}
