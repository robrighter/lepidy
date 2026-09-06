import { THEME_STORAGE_KEY } from "@/src/shell/shell-model";

/**
 * Applies the stored theme before first paint. Without this the page renders
 * light and then flips, which is worse than not offering dark mode at all.
 */
export function ThemeScript() {
  const source = `(function(){try{var p=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})||"system";var d=p==="dark"||(p==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.dataset.theme=d?"dark":"light";r.dataset.themePreference=p;}catch(e){}})();`;
  return <script dangerouslySetInnerHTML={{ __html: source }} />;
}
