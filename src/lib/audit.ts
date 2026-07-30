import { prisma } from "@/lib/prisma";

export async function writeAudit(params: {
  userId: string;
  action: "CREATE" | "UPDATE" | "DEACTIVATE" | "REACTIVATE";
  entity: string;
  entityId?: string;
  summary?: string;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId: params.userId,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId,
      summary: params.summary,
    },
  });
}
