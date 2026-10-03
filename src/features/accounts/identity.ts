/** Only a persisted title-at-action is displayed in history. Never use a later profile title. */
export function actorDisplayName(name: string, designation?: string | null): string {
  return designation ? `${name} (${designation})` : name;
}
