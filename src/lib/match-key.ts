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

/**
 * Dealer names need a stricter fuzzy score than product names. These terms carry little identity
 * on their own, but multi-word phrases containing them remain meaningful (e.g. "Beej Bhandar").
 */
const DEALER_GENERIC_TOKENS = new Set([
  "agency", "agencies", "agro", "and", "brother", "brothers", "centre", "center",
  "enterprise", "enterprises", "fertilizer", "fertilizers", "kendra", "patel", "seed", "seeds", "service",
  "trader", "traders", "trading", "store", "stores", "sons", "shree", "sri", "the",
]);
const DEALER_LOCATION_TOKENS = new Set([
  "ap", "br", "cg", "dl", "ga", "gj", "hr", "jh", "ka", "kl", "mh", "ml", "mp", "od", "pb", "rj", "tn", "ts", "uk", "up", "wb",
]);

/** Normalise common Indian-language spelling variants without changing the original display name. */
function dealerToken(token: string): string {
  return token
    .replace(/ph/g, "f")
    .replace(/sh/g, "s")
    .replace(/ee/g, "i")
    .replace(/ii/g, "i");
}

export interface DealerNameProfile {
  normalized: string;
  tokens: string[];
  meaningful: string[];
}

/** Build once for master dealers; safe to build on demand for an uploaded name. */
export function dealerNameProfile(name: string): DealerNameProfile {
  const tokens = looseKey(name)
    .split(" ")
    .filter(Boolean)
    .map(dealerToken);
  return {
    normalized: tokens.join(" "),
    tokens,
    meaningful: tokens.filter((token) => !DEALER_GENERIC_TOKENS.has(token) && !DEALER_LOCATION_TOKENS.has(token)),
  };
}

function tokenWeight(token: string): number {
  if (DEALER_LOCATION_TOKENS.has(token)) return 0;
  if (DEALER_GENERIC_TOKENS.has(token)) return 0.2;
  return 1 + Math.min(token.length, 12) / 24;
}

function f1(shared: number, left: number, right: number): number {
  if (!shared || !left || !right) return 0;
  const precision = shared / right;
  const recall = shared / left;
  return (2 * precision * recall) / (precision + recall);
}

/** Longest contiguous shared token phrase. Word order is meaningful in dealer names. */
function longestCommonPhrase(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        best = Math.max(best, dp[i][j]);
      }
    }
  }
  return best;
}

/**
 * Production dealer-name score in [0, 1]. It combines weighted word overlap, phrase overlap and
 * edit distance. Unlike the old fixed substring score, a short/generic name cannot dominate a
 * longer specific one; a long contiguous phrase can still match a master name with a location
 * suffix or a proprietor prefix.
 */
export function dealerSimilarityWithProfile(rawName: string, candidate: DealerNameProfile): number {
  const input = dealerNameProfile(rawName);
  if (!input.normalized || !candidate.normalized) return 0;
  if (input.normalized === candidate.normalized) return 1;

  const inputSet = new Set(input.tokens);
  const candidateSet = new Set(candidate.tokens);
  const sharedTokens = [...inputSet].filter((token) => candidateSet.has(token));
  const tokenF1 = f1(sharedTokens.length, inputSet.size, candidateSet.size);

  const inputWeight = [...inputSet].reduce((sum, token) => sum + tokenWeight(token), 0);
  const candidateWeight = [...candidateSet].reduce((sum, token) => sum + tokenWeight(token), 0);
  const sharedWeight = sharedTokens.reduce((sum, token) => sum + tokenWeight(token), 0);
  const weightedF1 = f1(sharedWeight, inputWeight, candidateWeight);

  const phraseWords = longestCommonPhrase(input.tokens, candidate.tokens);
  const phraseF1 = f1(phraseWords, input.tokens.length, candidate.tokens.length);
  const edit = 1 - levenshtein(input.normalized, candidate.normalized) / Math.max(input.normalized.length, candidate.normalized.length);

  let score = 0.38 * tokenF1 + 0.28 * weightedF1 + 0.22 * phraseF1 + 0.12 * edit;

  // A shared three-or-more-word phrase is strong evidence even when one side adds a location or
  // proprietor prefix. Do not apply this to short generic substring matches.
  const inputPhraseCoverage = phraseWords / input.tokens.length;
  const candidatePhraseCoverage = phraseWords / candidate.tokens.length;
  const phraseHasSpecificWord = input.tokens
    .slice(0)
    .some((token) => !DEALER_GENERIC_TOKENS.has(token) && !DEALER_LOCATION_TOKENS.has(token) && candidateSet.has(token));
  if (phraseWords >= 3 && phraseHasSpecificWord && (inputPhraseCoverage === 1 || candidatePhraseCoverage === 1)) {
    score += 0.18;
  }

  // A missing meaningful word (such as a town) prevents a short partial name from auto-matching.
  const unmatchedMeaningful = input.meaningful.filter((token) => !candidateSet.has(token)).length;
  if (phraseWords < 3 && input.meaningful.length > 0) {
    score -= 0.18 * (unmatchedMeaningful / input.meaningful.length);
  }

  return Math.max(0, Math.min(1, score));
}

export function dealerSimilarity(a: string, b: string): number {
  return dealerSimilarityWithProfile(a, dealerNameProfile(b));
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
