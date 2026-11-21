"use client";

import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAdminPermission } from "@/features/accounts/permission-ui";
import { useLabel } from "@/features/labels/label-ui";
import { api } from "@/lib/api-client";

/** One idempotent write per screen mount. Existing manual selections and read-only grants win. */
export function AutoLinkDistricts({ ready }: { ready: boolean }) {
  const canManage = useAdminPermission("partyPlanning", "manage");
  const qc = useQueryClient();
  const started = useRef(false);
  const failure = useLabel("party_planning.territory.district.auto_link_failed");
  const { mutate, isError } = useMutation({
    mutationFn: () => api.post<{ linked: number }>("/api/territory-mapping/districts/auto-link", {}),
    onSuccess: result => { if (result.linked) qc.invalidateQueries({ queryKey: ["territory-dealers"] }); },
  });
  useEffect(() => {
    if (ready && canManage && !started.current) { started.current = true; mutate(); }
  }, [ready, canManage, mutate]);
  return isError ? <p role="status" className="text-sm text-muted-foreground">{failure}</p> : null;
}
