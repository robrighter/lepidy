"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import {
  THEME_STORAGE_KEY,
  nextThemePreference,
  parseThemePreference,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from "@/src/shell/shell-model";

function prefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function ThemeToggle() {
  // The document already carries the resolved theme from the pre-paint script;
  // this state only mirrors it once React takes over.
  const [preference, setPreference] = useState<ThemePreference>("system");
  const [theme, setTheme] = useState<ResolvedTheme>("light");

  useEffect(() => {
    let stored: ThemePreference = "system";
    try {
      stored = parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
      stored = "system";
    }
    setPreference(stored);
    setTheme(resolveTheme(stored, prefersDark()));
  }, []);

  function toggle() {
    const next = nextThemePreference(preference, prefersDark());
    const resolved = resolveTheme(next, prefersDark());
    setPreference(next);
    setTheme(resolved);
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // A browser that refuses storage still gets the theme for this session.
    }
  }

  return (
    <button
      type="button"
      className="icon-button"
      onClick={toggle}
      aria-pressed={theme === "dark"}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
    >
      {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}
