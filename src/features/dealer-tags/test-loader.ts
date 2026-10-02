/** Load server-only modules under Node tests while preserving their real implementation. */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const localRequire = createRequire(import.meta.url);
export class TestApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function testLoader(overrides: Record<string, unknown>) {
  const cache = new Map<string, unknown>();
  function load<T>(file: string): T {
    file = resolve(file);
    if (cache.has(file)) return cache.get(file) as T;
    const source = readFileSync(file, "utf8");
    const mod = { exports: {} };
    cache.set(file, mod.exports);
    const code = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }).outputText;
    runInNewContext(code, {
      module: mod,
      exports: mod.exports,
      require: (name: string) => {
        if (name === "server-only") return {};
        if (name in overrides) return overrides[name];
        if (name.startsWith("@/") || name.startsWith("./")) {
          const base = name.startsWith("@/")
            ? `src/${name.slice(2)}`
            : resolve(dirname(file), name);
          try {
            return load(`${base}.ts`);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            return load(`${base}.tsx`);
          }
        }
        return localRequire(name);
      },
      console,
      Date,
      Map,
      Set,
      Math,
      Buffer,
      process,
    });
    cache.set(file, mod.exports);
    return mod.exports as T;
  }
  return load;
}
