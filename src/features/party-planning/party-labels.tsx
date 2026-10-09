import { Fragment, type ReactNode } from "react";
import { useLabel } from "@/features/labels/label-ui";
import type { LabelKey } from "@/features/labels/labels";

/**
 * Party Planning helpers on top of the existing label lookup (`useLabel`): resolve a fixed set of keys in one call, and fill `{placeholders}`
 * in a label. The key set at a call site must not change between renders (it is a constant object literal everywhere it is used).
 */
export function useLabels<T extends Record<string, LabelKey>>(map: T): { [K in keyof T]: string } {
  const names = Object.keys(map);
  const values = names.map((n) => map[n] as LabelKey).map(useLabel);
  return Object.fromEntries(names.map((n, i) => [n, values[i]])) as { [K in keyof T]: string };
}

/** Replace `{name}` placeholders with runtime values; an unknown placeholder is left as typed. */
export function fill(text: string, vars: Record<string, string | number | null | undefined>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? "") : m));
}

/** Like `fill`, but values may be elements (e.g. bold names inside a confirmation sentence). */
export function fillNodes(text: string, vars: Record<string, ReactNode>): ReactNode {
  const parts = text.split(/(\{\w+\})/g);
  return parts.map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return <Fragment key={i}>{m && m[1]! in vars ? vars[m[1]!] : part}</Fragment>;
  });
}
