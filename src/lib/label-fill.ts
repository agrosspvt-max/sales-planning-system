/** Replace `{name}` placeholders in a label with runtime values; an unknown placeholder is left as typed. Shared by browser and server so edited wording keeps working. */
export function fillLabel(text: string, vars: Record<string, string | number | null | undefined>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? "") : m));
}
