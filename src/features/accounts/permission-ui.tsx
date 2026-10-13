"use client";
import { createContext, useContext } from "react";
import { Role } from "@prisma/client";
import { canCreateBillingException, hasAdminPermission, type AdminModule, type PermissionIdentity } from "./permissions";
export const PermissionContext = createContext<PermissionIdentity>({ role: Role.SUPER_ADMIN });
/** Presentation only. The server independently authorizes every operation. */
export function useAdminPermission(module: AdminModule, action = "read") {
  const identity = useContext(PermissionContext);
  return identity.role !== Role.CUSTOM_ADMIN || hasAdminPermission(identity, module, action);
}
/** Presentation only (the API re-checks on every request): may this user open the Create-a-Billing-Exception action? Unlike `useAdminPermission` it is false for SO / RM. */
export function useCanCreateBillingException() {
  return canCreateBillingException(useContext(PermissionContext));
}
