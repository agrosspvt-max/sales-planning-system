"use client";
import { createContext, useContext } from "react";
import { Role } from "@prisma/client";
import { hasAdminPermission, type AdminModule, type PermissionIdentity } from "./permissions";
export const PermissionContext = createContext<PermissionIdentity>({ role: Role.SUPER_ADMIN });
/** Presentation only. The server independently authorizes every operation. */
export function useAdminPermission(module: AdminModule, action = "read") {
  const identity = useContext(PermissionContext);
  return identity.role !== Role.CUSTOM_ADMIN || hasAdminPermission(identity, module, action);
}
