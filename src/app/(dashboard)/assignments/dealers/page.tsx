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
        description: "Assign dealers to Sales Officers. History is preserved automatically.",
        endpoint: "/api/dealer-assignments",
        canManage: can(role, "dealerAssignments", "create"),
        columns: [
          { key: "dealerName", label: "Dealer" },
          { key: "officerName", label: "Sales Officer" },
          { key: "effectiveFrom", label: "Effective From" },
        ],
        fields: [
          { name: "dealerId", label: "Dealer", optionsKey: "dealers" },
          { name: "officerId", label: "Sales Officer", optionsKey: "officers" },
        ],
        history: {
          param: "dealerId",
          idKey: "dealerId",
          nameKey: "officerName",
          nameLabel: "Sales Officer",
          subjectKey: "dealerId",
        },
      }}
    />
  );
}
