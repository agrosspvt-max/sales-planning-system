/**
 * Initial District master from the four supplied state workbooks (sheet "Districts": S.No | District Name). SAFE and REPEATABLE:
 *   - DRY-RUN by default: prints what would happen and writes NOTHING. Pass --apply to write.
 *   - Each workbook state is mapped to an EXISTING UserGroup (never created): by explicit --group KEY=<groupId|exact name>, else by exactly
 *     one group whose name is the state's full name or code. Zero / several / duplicate matches → STOP, nothing is written.
 *   - Only NEW districts are created (idempotent: a re-run creates nothing); existing ones, active or not, are never changed or deleted.
 *   - Aliases (scripts/district-aliases.json) are loaded only with --with-aliases, and each must point at a district of that state's list.
 *
 *   npx tsx scripts/district-seed.ts --dir ~/Downloads                      # dry run
 *   npx tsx scripts/district-seed.ts --dir ~/Downloads --group MP=<groupId>  # override a mapping
 *   npx tsx scripts/district-seed.ts --dir ~/Downloads --apply [--with-aliases] [--user <userId for the audit entry>]
 *
 * Connection: DIRECT_URL, else DATABASE_URL. Never run this against production without the owner's sign-off.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx";
import { cleanDistrictName, districtKey, parseDistrictSheet, planDistrictImport, resolveSeedGroups, type SeedState } from "../src/lib/district-master";

const STATES: (SeedState & { file: string })[] = [
  { key: "MP", file: "Madhya_Pradesh_Districts.xlsx", names: ["Madhya Pradesh", "MP"] },
  { key: "UP", file: "Uttar_Pradesh_Districts.xlsx", names: ["Uttar Pradesh", "UP"] },
  { key: "CG", file: "Chhattisgarh_Districts.xlsx", names: ["Chhattisgarh", "CG"] },
  { key: "WB", file: "West_Bengal_Districts.xlsx", names: ["West Bengal", "WB"] },
];

function arg(name: string): string | null { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? "" : null; }
const flag = (name: string) => process.argv.includes(name);

async function main() {
  const dir = arg("--dir");
  if (!dir) throw new Error("Pass --dir <folder with the four *_Districts.xlsx workbooks>");
  const apply = flag("--apply"), withAliases = flag("--with-aliases");
  const overrides: Record<string, string> = {};
  process.argv.forEach((a, i) => { if (a === "--group") { const [k, ...v] = (process.argv[i + 1] ?? "").split("="); if (k && v.length) overrides[k.toUpperCase()] = v.join("="); } });
  const aliasFile = JSON.parse(readFileSync(resolve(__dirname, "district-aliases.json"), "utf8")) as Record<string, Record<string, string>>;

  const prisma = new PrismaClient(process.env.DIRECT_URL ? { datasources: { db: { url: process.env.DIRECT_URL } } } : undefined);
  try {
    const groups = await prisma.userGroup.findMany({ select: { id: true, name: true } });
    const mapping = resolveSeedGroups(STATES, groups, overrides);
    const problems: string[] = [];
    for (const m of mapping) if ("error" in m) problems.push(`${m.key}: ${m.error}`);
    console.log("State → group mapping:");
    for (const m of mapping) console.log("  ", m.key, "error" in m ? `✗ ${m.error}` : `→ "${m.groupName}" (${m.groupId}) via ${m.via}`);
    console.log("Existing groups:", groups.map((g) => g.name).join(", ") || "(none)");
    if (problems.length) throw new Error(`Cannot resolve every state to an existing group — nothing was written.\n${problems.join("\n")}`);

    type Write = { groupId: string; names: string[]; aliases: { alias: string; canonical: string }[] };
    const writes: Write[] = [];
    for (const state of STATES) {
      const m = mapping.find((x) => x.key === state.key)!;
      if ("error" in m) continue;
      const wb = XLSX.readFile(resolve(dir, state.file));
      const sheet = wb.SheetNames.find((n) => n.toLowerCase() === "districts") ?? wb.SheetNames[0]!;
      const parsed = parseDistrictSheet(XLSX.utils.sheet_to_json(wb.Sheets[sheet]!, { header: 1, blankrows: true, defval: null }) as unknown[][]);
      if (parsed.error) throw new Error(`${state.file}: ${parsed.error}`);
      const existing = await prisma.district.findMany({ where: { groupId: m.groupId }, select: { id: true, name: true, nameKey: true, isActive: true } });
      const plan = planDistrictImport(parsed, existing);
      const bad = plan.filter((r) => r.status === "INVALID");
      if (bad.length) throw new Error(`${state.file}: invalid rows — ${bad.map((r) => `row ${r.rowNumber} (${r.reason})`).join("; ")}`);
      const fresh = plan.filter((r) => r.status === "NEW").map((r) => r.name);
      const known = new Set([...existing.map((d) => d.nameKey), ...fresh.map(districtKey)]);
      const aliases = Object.entries(aliasFile[state.key] ?? {}).map(([alias, canonical]) => ({ alias, canonical }));
      for (const a of aliases) if (!known.has(districtKey(a.canonical))) throw new Error(`${state.key} alias "${a.alias}" points at "${a.canonical}", which is not in that state's list`);
      console.log(`${state.key} (${m.groupName}): ${plan.length} rows · ${fresh.length} new · ${plan.filter((r) => r.status === "EXISTS").length} already present · aliases ${withAliases ? aliases.length : `(${aliases.length} not loaded — pass --with-aliases)`}`);
      writes.push({ groupId: m.groupId, names: fresh, aliases: withAliases ? aliases : [] });
    }
    if (!apply) { console.log("\nDRY RUN — nothing was written. Re-run with --apply to create the new districts."); return; }
    await prisma.$transaction(async (tx) => {
      for (const w of writes) {
        for (const name of w.names) await tx.district.create({ data: { groupId: w.groupId, name: cleanDistrictName(name), nameKey: districtKey(name), isActive: true } });
        for (const a of w.aliases) {
          const d = await tx.district.findFirst({ where: { groupId: w.groupId, nameKey: districtKey(a.canonical) }, select: { id: true } });
          if (!d) throw new Error(`alias target "${a.canonical}" missing`);
          const have = await tx.districtAlias.findFirst({ where: { groupId: w.groupId, aliasKey: districtKey(a.alias) }, select: { id: true } });
          if (!have) await tx.districtAlias.create({ data: { districtId: d.id, groupId: w.groupId, alias: a.alias, aliasKey: districtKey(a.alias) } });
        }
      }
      const user = arg("--user"); // optional: an existing user id to attribute the audit entry to
      if (user) await tx.auditLog.create({ data: { userId: user, action: "CREATE", entity: "district", entityId: null, summary: `District master seed: ${writes.reduce((n, w) => n + w.names.length, 0)} district(s) created` } });
    }, { timeout: 60_000 });
    console.log("\nApplied.");
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error(String((e as Error).message ?? e)); process.exit(1); });
