/**
 * The ONE matching utility for the whole app (Section 41 — Import Matching). Every importer
 * (Seasonal Import, Company Onboarding, Dealer Import, Product Price Import, and any future
 * pipeline) resolves Product / Dealer / Pack Size names through these helpers — no importer
 * defines its own normalisation or fuzzy logic.
 *
 * Strategy (in order): tightKey exact → looseKey exact → fuzzy similarity (only when enabled).
 *
 *  - looseKey: lowercase, collapse punctuation to single spaces ("A.B" == "A B").
 *  - tightKey: lowercase, strip ALL non-alphanumerics ("25ML" == "25 ML" == "25-ML").
 */
export function looseKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function tightKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return dp[m][n];
}

/** Fuzzy similarity in [0,1]: max of Levenshtein ratio, token Jaccard, and substring. */
export function similarity(a: string, b: string): number {
  const na = looseKey(a);
  const nb = looseKey(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const lev = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  const inter = [...ta].filter((x) => tb.has(x)).length;
  const uni = new Set([...ta, ...tb]).size;
  const jac = uni ? inter / uni : 0;
  const sub = na.includes(nb) || nb.includes(na) ? 0.9 : 0;
  return Math.max(lev, jac, sub);
}

export interface Keyed {
  tight: string;
  loose: string;
}

/** Decorate rows with their match keys once, so lookups are O(1)/O(n) without recomputing. */
export function decorate<T extends { name: string }>(rows: T[]): (T & Keyed)[] {
  return rows.map((r) => ({ ...r, tight: tightKey(r.name), loose: looseKey(r.name) }));
}

/**
 * Resolve a raw value against a decorated list: tight exact → loose exact → (optional) best
 * fuzzy ≥ threshold. Returns the matched row or null.
 */
export function matchByName<T extends Keyed & { name: string }>(
  value: string,
  list: T[],
  opts: { fuzzy?: boolean; threshold?: number } = {},
): T | null {
  const t = tightKey(value);
  if (t) {
    const m = list.find((x) => x.tight === t);
    if (m) return m;
  }
  const l = looseKey(value);
  if (l) {
    const m = list.find((x) => x.loose === l);
    if (m) return m;
  }
  if (!opts.fuzzy) return null;
  const threshold = opts.threshold ?? 0.9;
  let best: { x: T; s: number } | null = null;
  for (const x of list) {
    const s = similarity(value, x.name);
    if (s >= threshold && (!best || s > best.s)) best = { x, s };
  }
  return best?.x ?? null;
}
