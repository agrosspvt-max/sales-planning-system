import { prisma } from "@/lib/prisma";

/** Minimal client surface writeAudit needs — satisfied by both `prisma` and a transaction client. */
interface AuditClient {
  auditLog: {
    create(args: { data: { userId: string; action: string; entity: string; entityId?: string | null; summary?: string | null } }): Promise<unknown>;
  };
}

export async function writeAudit(
  params: {
    userId: string;
    action:
      | "CREATE"
      | "UPDATE"
      | "DEACTIVATE"
      | "REACTIVATE"
      | "DELETE"
      // Plan lifecycle management (Seasonal / Monthly / Recovery): freeze, hide, restore, replace.
      | "CLOSE"
      | "REOPEN"
      | "REPLACE"
      // Move a Recovery Plan from one Seasonal Plan version to another (relation-only change).
      | "TRANSFER"
      // Permanent, irreversible deletion of a Scheme and all its scheme-owned records. The audit row
      // itself survives (it has no FK to Scheme); the deleted scheme's id/name/reason/counts are snapshotted.
      | "SCHEME_PERMANENTLY_DELETED";
    entity: string;
    entityId?: string;
    summary?: string;
  },
  // Pass a transaction client to keep the audit write atomic with the change it records; when omitted
  // the write uses the shared prisma client (the previous, non-transactional behaviour).
  client?: AuditClient,
): Promise<void> {
  const data = {
    userId: params.userId,
    action: params.action,
    entity: params.entity,
    entityId: params.entityId,
    summary: params.summary,
  };
  if (client) await client.auditLog.create({ data });
  else await prisma.auditLog.create({ data });
}
