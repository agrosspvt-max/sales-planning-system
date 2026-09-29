/**
 * Recovery config — Auto Tasks VISIBILITY flag (default OFF). DB-free.
 *   npx tsx src/lib/recovery-config.test.ts
 *
 * Proves the "Enable Auto Tasks" setting:
 *   - defaults OFF when the key is missing,
 *   - turns ON only for an explicit "true" (never for other truthy-looking strings),
 *   - round-trips through saveRecoveryConfig,
 * while the existing dueValidation/calendarEnabled defaults (ON) are unchanged.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const localRequire = createRequire(import.meta.url);

function loadConfig(store: Map<string, string>) {
  const systemSetting = {
    findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
      where.key.in.filter((k) => store.has(k)).map((key) => ({ key, value: store.get(key)! })),
    findUnique: async ({ where }: { where: { key: string } }) =>
      store.has(where.key) ? { value: store.get(where.key)! } : null,
    upsert: async ({ where, create, update }: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }) => {
      store.set(where.key, store.has(where.key) ? update.value : create.value);
      return {};
    },
  };
  const prisma = { systemSetting, $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops) };
  const filename = resolve("src/lib", "recovery-config.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  const mocks: Record<string, unknown> = { "server-only": {}, "@/lib/prisma": { prisma } };
  runInNewContext(code, { exports, Date, console, process, require: (id: string) => id in mocks ? mocks[id] : localRequire(id) }, { filename });
  return exports as typeof import("./recovery-config");
}

let passed = 0;
function test(name: string, fn: () => Promise<void> | void) { return Promise.resolve(fn()).then(() => { passed += 1; console.log(`  ok  ${name}`); }); }

async function main() {
  await test("Auto Tasks defaults OFF when the key is missing (other defaults stay ON)", async () => {
    const cfg = loadConfig(new Map());
    const rc = await cfg.getRecoveryConfig();
    assert.equal(rc.autoTasksEnabled, false);
    assert.equal(await cfg.getAutoTasksEnabled(), false);
    assert.equal(rc.dueValidation, true, "dueValidation still defaults ON");
    assert.equal(rc.calendarEnabled, true, "calendarEnabled still defaults ON");
  });

  await test("only an explicit \"true\" turns Auto Tasks ON", async () => {
    for (const value of ["false", "1", "yes", "TRUE", "", "on"]) {
      const cfg = loadConfig(new Map([[cfg_key(), value]]));
      assert.equal(await cfg.getAutoTasksEnabled(), false, `value ${JSON.stringify(value)} must stay OFF`);
      assert.equal((await cfg.getRecoveryConfig()).autoTasksEnabled, false, `value ${JSON.stringify(value)} must stay OFF`);
    }
    const on = loadConfig(new Map([[cfg_key(), "true"]]));
    assert.equal(await on.getAutoTasksEnabled(), true);
    assert.equal((await on.getRecoveryConfig()).autoTasksEnabled, true);
  });

  await test("saveRecoveryConfig round-trips the Auto Tasks flag", async () => {
    const store = new Map<string, string>();
    const cfg = loadConfig(store);
    await cfg.saveRecoveryConfig({ dueValidation: true, calendarEnabled: true, autoTasksEnabled: true });
    assert.equal(store.get(cfg_key()), "true");
    assert.equal(await cfg.getAutoTasksEnabled(), true);
    await cfg.saveRecoveryConfig({ dueValidation: true, calendarEnabled: true, autoTasksEnabled: false });
    assert.equal(store.get(cfg_key()), "false");
    assert.equal(await cfg.getAutoTasksEnabled(), false);
  });

  console.log(`\n${passed} recovery-config tests passed`);
}

// The setting key is internal; read it from the module once for the assertions above.
function cfg_key(): string { return "recovery.autoTasksEnabled"; }

main().catch((error) => { console.error(error); process.exit(1); });
