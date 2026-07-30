import { auth } from "@/auth";
import { can } from "@/lib/rbac";
import { Forbidden } from "@/components/layout/forbidden";
import { AssignmentPage } from "@/features/assignments/assignment-page";

export default async function Page() {
  const session = await auth();
  const role = session!.user.role;
  if (!can(role, "rmAssignments", "read")) return <Forbidden />;

  return (
    <AssignmentPage
      config={{
        title: "RM Assignments",
        description:
          "Assign Sales Officers to Regional Managers. Officers without an assignment report directly to the Super Admin.",
        endpoint: "/api/rm-assignments",
        canManage: can(role, "rmAssignments", "create"),
        columns: [
          { key: "officerName", label: "Sales Officer" },
          { key: "managerName", label: "Regional Manager" },
          { key: "effectiveFrom", label: "Effective From" },
        ],
        fields: [
          { name: "officerId", label: "Sales Officer", optionsKey: "officers" },
          { name: "managerId", label: "Regional Manager", optionsKey: "managers" },
        ],
        history: {
          param: "officerId",
          idKey: "officerId",
          nameKey: "managerName",
          nameLabel: "Regional Manager",
          subjectKey: "officerId",
        },
      }}
    />
  );
}
