import { auth } from "@/auth";
import { can } from "@/lib/rbac";
import { Forbidden } from "@/components/layout/forbidden";
import { AssignmentPage } from "@/features/assignments/assignment-page";

export default async function Page() {
  const session = await auth();
  const role = session!.user.role;
  if (!can(role, "dealerAssignments", "read")) return <Forbidden />;

  return (
    <AssignmentPage
      config={{
        title: "Dealer Assignments",
        description: "Assign dealers to a Sales Officer or Regional Manager. History is preserved automatically.",
        endpoint: "/api/dealer-assignments",
        canManage: can(role, "dealerAssignments", "create"),
        columns: [
          { key: "dealerName", label: "Dealer" },
          { key: "officerName", label: "Owner" },
          { key: "effectiveFrom", label: "Effective From" },
        ],
        fields: [
          { name: "dealerId", label: "Dealer", optionsKey: "dealers" },
          // Owner may be a Sales Officer OR a Regional Manager (RMs own their own dealers too).
          { name: "officerId", label: "Owner", optionsKey: "dealerOwners" },
        ],
        history: {
          param: "dealerId",
          idKey: "dealerId",
          nameKey: "officerName",
          nameLabel: "Owner",
          subjectKey: "dealerId",
        },
      }}
    />
  );
}
