import type { ColumnDef } from "@/features/resources/config";
import { ROLE_LABELS } from "@/lib/rbac";
import { formatCurrency, formatDate, formatPercent } from "@/lib/utils";
import type { Role } from "@prisma/client";

export function formatCell(value: unknown, format?: ColumnDef["format"]): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (format) {
    case "currency":
      return formatCurrency(value as number | string);
    case "percent":
      return formatPercent(value as number | string);
    case "date":
      return formatDate(value as string);
    case "boolean":
      return value ? "Active" : "Inactive";
    case "role":
      return ROLE_LABELS[value as Role] ?? String(value);
    default:
      return String(value);
  }
}
