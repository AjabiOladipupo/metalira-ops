import { THEME_STORAGE_KEY } from "./theme";

/**
 * Runs before first paint so the page never flashes the wrong theme.
 * Reads the saved choice (light, dark or system) and sets the class on <html>.
 */
const script = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})||"system";var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
