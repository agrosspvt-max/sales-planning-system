/** Only a persisted title-at-action is displayed in history. Never use a later profile title. */
export function actorDisplayName(name: string, designation?: string | null): string {
  return designation ? `${name} (${designation})` : name;
}

/** Display only the name from older CN account snapshots, without rewriting their audit identity. */
export function accountSnapshotName(value: string): string {
  return value.replace(/\s+\(@[^)]+\)(?:\s+\([\s\S]*\))?\s*$/, "");
}

/** Only Account Management accounts use the name fallback for an optional designation. */
export function accountBadgeLabel(name: string, role: string, designation: string | null | undefined, roleLabel: string): string {
  if (role === "CUSTOM_ADMIN") return designation?.trim() || name;
  return role === "SALES_OFFICER" ? name : designation ?? roleLabel;
}
