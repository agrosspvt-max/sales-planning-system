/**
 * Excel worksheet names for generated workbooks. A name must be 1–31 characters, may not contain : \ / ? * [ ], may not start or end with an
 * apostrophe, must be unique ignoring case, and must not be the reserved name "History". Formula references quote every name (apostrophes doubled),
 * so a name with spaces, apostrophes or other punctuation is always referenced correctly. Callers map their own stable ids to the names returned
 * here — formulas never derive a sheet from a display name.
 */
export const SHEET_NAME_MAX = 31;
const INVALID = /[:\\/?*[\]]/g;

export function cleanSheetName(raw: string, fallback = "Sheet"): string {
  let name = raw.replace(INVALID, " ").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  name = name.replace(/^'+|'+$/g, "").trim();
  if (name.length > SHEET_NAME_MAX) name = name.slice(0, SHEET_NAME_MAX).replace(/'+$/, "").trimEnd();
  return name || fallback;
}

/** Allocates unique worksheet names (case-insensitive), reserving the given names first. */
export class SheetNameRegistry {
  private readonly taken = new Set<string>(["history"]);
  constructor(reserved: string[] = []) { for (const r of reserved) this.taken.add(r.toLowerCase()); }

  allocate(raw: string, fallback = "Sheet"): string {
    const base = cleanSheetName(raw, fallback);
    if (!this.taken.has(base.toLowerCase())) { this.taken.add(base.toLowerCase()); return base; }
    for (let n = 2; ; n++) {
      const suffix = ` (${n})`;
      const stem = base.slice(0, SHEET_NAME_MAX - suffix.length).replace(/'+$/, "").trimEnd() || fallback.slice(0, SHEET_NAME_MAX - suffix.length);
      const candidate = `${stem}${suffix}`;
      if (!this.taken.has(candidate.toLowerCase())) { this.taken.add(candidate.toLowerCase()); return candidate; }
    }
  }
}

/** `'Sheet name'!` — always quoted, apostrophes doubled. */
export const sheetRef = (name: string): string => `'${name.replace(/'/g, "''")}'!`;
/** A 3D reference prefix over a contiguous run of sheets: `'First:Last'!`. */
export const sheetRangeRef = (first: string, last: string): string => (first === last ? sheetRef(first) : `'${first.replace(/'/g, "''")}:${last.replace(/'/g, "''")}'!`);
