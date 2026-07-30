"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  /** The user's selection: light, dark, or follow system. */
  theme: Theme;
  /** The concrete theme currently applied (system resolved to light/dark). */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const THEME_STORAGE_KEY = "theme";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(resolved: ResolvedTheme) {
  const el = document.documentElement;
  el.classList.toggle("dark", resolved === "dark");
  // Native form controls / scrollbars follow the theme.
  el.style.colorScheme = resolved;
}

/**
 * Single global theme provider.
 *
 * Resolution priority: stored user preference → system preference → Light. The choice is
 * persisted to localStorage (so it survives logout/login), the `.dark` class is toggled on
 * <html>, and the app reacts instantly on change. A no-flash inline script in the root
 * layout applies the same logic before first paint, so there is no theme flicker and no
 * hydration mismatch (the <html> class is set outside React and marked
 * suppressHydrationWarning).
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");

  // Load the persisted preference once on mount.
  useEffect(() => {
    const stored = (localStorage.getItem(THEME_STORAGE_KEY) as Theme | null) ?? "system";
    setThemeState(stored);
  }, []);

  // Recompute + apply whenever the preference (or the system setting, when following it) changes.
  useEffect(() => {
    const compute = () => {
      const resolved: ResolvedTheme = theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
      setResolvedTheme(resolved);
      applyTheme(resolved);
    };
    compute();
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", compute);
      return () => mq.removeEventListener("change", compute);
    }
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* storage unavailable — session-only */
    }
  }, []);

  return <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}

/**
 * The inline script string executed in <head> before paint to prevent a flash of the wrong
 * theme. Kept identical in logic to the provider's resolution.
 */
export const NO_FLASH_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var e=document.documentElement;e.classList.toggle('dark',d);e.style.colorScheme=d?'dark':'light';}catch(e){}})();`;
