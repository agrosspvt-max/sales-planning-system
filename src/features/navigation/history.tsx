"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Centralized navigation history — the ONE source of truth for "Back".
 *
 * A sessionStorage-backed stack of visited URLs (path + query) records the user's real journey, so
 * Back returns to the page they actually came from (with its query params: filters, tabs, selected
 * officer/season) instead of a hardcoded logical parent. The Dashboard (home) RESETS the stack, so a
 * new journey never inherits the previous one. Every page inherits this through the shared
 * PageHeader/BackButton — no per-page wiring.
 */

const HOME = "/dashboard";
const STORAGE_KEY = "nav:stack";
const MAX = 50;

interface NavHistoryValue {
  /** The URL the user came from, or null at the start of a journey. */
  previous: string | null;
  /** Navigate back: real history first, else the given fallback, else the browser stack. */
  back: (fallback?: string) => void;
  canBack: boolean;
}

const Ctx = createContext<NavHistoryValue | null>(null);

function loadStack(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
function saveStack(stack: string[]) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stack));
  } catch {
    /* sessionStorage unavailable (private mode) — Back falls back to the browser stack. */
  }
}

export function NavHistoryProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [stack, setStack] = useState<string[]>([]);

  const qs = searchParams?.toString();
  const current = qs ? `${pathname}?${qs}` : pathname;

  useEffect(() => {
    let next = loadStack();
    if (pathname === HOME) {
      // Dashboard is home — reset the journey so Back doesn't cross into a previous one.
      next = [current];
    } else if (next.length && next[next.length - 1] === current) {
      // Same page re-render (e.g. a query-param no-op) — leave the stack unchanged.
    } else if (next.length >= 2 && next[next.length - 2] === current) {
      // The user navigated Back — pop the current top.
      next = next.slice(0, -1);
    } else {
      next = [...next, current];
      if (next.length > MAX) next = next.slice(next.length - MAX);
    }
    saveStack(next);
    setStack(next);
    // `current` fully captures pathname + query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const previous = stack.length >= 2 ? stack[stack.length - 2] : null;

  const back = useCallback(
    (fallback?: string) => {
      // Re-read from storage so we act on the freshest stack even mid-transition.
      const s = loadStack();
      const prev = s.length >= 2 ? s[s.length - 2] : null;
      if (prev) router.push(prev);
      else if (fallback) router.push(fallback);
      else router.back();
    },
    [router],
  );

  return <Ctx.Provider value={{ previous, back, canBack: previous != null }}>{children}</Ctx.Provider>;
}

/** Access the navigation history. Falls back to the browser stack when no provider is mounted. */
export function useNavHistory(): NavHistoryValue {
  const ctx = useContext(Ctx);
  if (ctx) return ctx;
  return {
    previous: null,
    canBack: false,
    back: (fallback?: string) => {
      if (typeof window === "undefined") return;
      if (fallback) window.location.href = fallback;
      else window.history.back();
    },
  };
}
