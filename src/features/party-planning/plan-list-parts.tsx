"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/** Shared pieces of the Party Planning Seasonal / Monthly LIST pages (the same list → create → Open pattern as Sales Planning). */

export const dateTimeText = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { dateStyle: "medium" });

const STATUS_VARIANT: Record<string, "muted" | "secondary" | "success" | "destructive" | "warning"> = {
  Draft: "muted", "Pending Approval": "secondary", Approved: "success", "Needs Changes": "destructive", "In Progress": "secondary", Completed: "success",
};
export function SheetStatusBadge({ status }: { status: string }) {
  return <Badge variant={STATUS_VARIANT[status] ?? "muted"}>{status}</Badge>;
}

/** The "Open" action: a plain route link (like Sales Planning's Open), so Back / Forward / refresh follow the URL. */
export function OpenButton({ href }: { href: string }) {
  return <Button asChild variant="outline" size="sm"><Link href={href}>Open</Link></Button>;
}
