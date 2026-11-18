import {
  THEME_CHANGE_EVENT,
  THEME_COLOR_DARK,
  THEME_COLOR_LIGHT,
  THEME_STORAGE_KEY,
} from "./theme";

/** Marks the one theme-color tag the script owns. React's own tags are never touched. */
export const OWNED_THEME_COLOR_ATTR = "data-theme-owned";

/**
 * The owned tag's colour, written in lower case. React 19 claims existing hoisted <meta> tags
 * while hydrating by their exact `content` string (and name), not by media; with the same
 * "#0A0A0A" as the worker app's dark tag, React would adopt the owned tag as its own, then
 * remove it on navigation and leave its real tag behind. Lower case is the same colour and
 * never matches.
 */
export function ownedColour(colour: string): string {
  return colour.toLowerCase();
}

/**
 * Runs before first paint so the page never flashes the wrong theme.
 * - Reads the saved choice (light, dark or system) and sets the class on <html>.
 * - Status bar colour: the worker app declares a light and a dark `<meta name="theme-color">`
 *   (viewport export) that follow the phone's setting. With Light or Dark chosen, the script puts
 *   ONE extra tag with no media first in <head>; the browser uses the first matching tag, so the
 *   installed app's status bar follows the theme chosen in the app. With System the extra tag is
 *   removed and the phone's setting wins again. React's tags are left alone (React matches
 *   hoisted metas by their content, so editing them would make it add duplicates), and React
 *   skips the extra tag when it hydrates the head. It updates on every theme change event, and
 *   moves the tag back to the front when a navigation inserts React's tags ahead of it.
 */
export const themeScript = `(function(){try{
var K=${JSON.stringify(THEME_STORAGE_KEY)},L=${JSON.stringify(ownedColour(THEME_COLOR_LIGHT))},D=${JSON.stringify(ownedColour(THEME_COLOR_DARK))},A=${JSON.stringify(OWNED_THEME_COLOR_ATTR)};
var h=document.documentElement;
function saved(){try{var v=localStorage.getItem(K);return v==="light"||v==="dark"?v:"system";}catch(e){return "system";}}
function paint(c){var o=document.head&&document.head.querySelector("meta["+A+"]");
if(c==="system"){if(o)o.parentNode.removeChild(o);return;}
if(!document.head)return;
if(!o){o=document.createElement("meta");o.setAttribute("name","theme-color");o.setAttribute(A,"");}
if(document.head.firstChild!==o)document.head.insertBefore(o,document.head.firstChild);
o.setAttribute("content",c==="dark"?D:L);}
var t=saved();
h.classList.toggle("dark",t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches));
paint(t);
if(typeof MutationObserver==="function"&&document.head){new MutationObserver(function(){var o=document.head.querySelector("meta["+A+"]");if(o&&document.head.firstChild!==o)document.head.insertBefore(o,document.head.firstChild);}).observe(document.head,{childList:true});}
addEventListener(${JSON.stringify(THEME_CHANGE_EVENT)},function(e){var c=e&&e.detail;paint(c==="light"||c==="dark"?c:"system");});
}catch(e){}})();`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: themeScript }} />;
}
