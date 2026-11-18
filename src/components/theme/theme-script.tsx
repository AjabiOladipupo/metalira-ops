import { THEME_CHANGE_EVENT, THEME_STORAGE_KEY } from "./theme";

/** Browser chrome colours (the installed worker app's status bar): `bg` light and dark. */
export const THEME_COLOR_LIGHT = "#FFFFFF";
export const THEME_COLOR_DARK = "#0A0A0A";

/**
 * Runs before first paint so the page never flashes the wrong theme.
 * - Reads the saved choice (light, dark or system) and sets the class on <html>.
 * - Keeps every `<meta name="theme-color">` (the worker app declares a light and a dark one in
 *   its viewport export) in step with the applied theme, so the installed app's status bar
 *   follows the theme chosen in the app, not only the phone's. With a fixed choice each tag gets
 *   that colour; with System each tag goes back to its own media's colour, so the browser keeps
 *   following the phone. It re-syncs on every theme change (applyThemeChoice fires the change
 *   event; System following the phone toggles the class) and when a client navigation adds the
 *   tags, so no other code has to.
 */
export const themeScript = `(function(){try{
var K=${JSON.stringify(THEME_STORAGE_KEY)},L=${JSON.stringify(THEME_COLOR_LIGHT)},D=${JSON.stringify(THEME_COLOR_DARK)};
var h=document.documentElement;
function choice(){try{var v=localStorage.getItem(K);return v==="light"||v==="dark"?v:"system";}catch(e){return "system";}}
var t=choice();
var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);
h.classList.toggle("dark",d);
var last=null;
function sync(e){if(e&&typeof e.detail==="string")last=e.detail;var c=last||choice(),dark=h.classList.contains("dark"),m=document.querySelectorAll('meta[name="theme-color"]');
for(var i=0;i<m.length;i++){var q=m[i].getAttribute("media")||"",v;
if(c==="system"&&q.indexOf("dark")>=0)v=D;else if(c==="system"&&q.indexOf("light")>=0)v=L;else v=dark?D:L;
if(m[i].getAttribute("content")!==v)m[i].setAttribute("content",v);}}
sync();
if(typeof MutationObserver==="function"){var o=new MutationObserver(sync);
o.observe(h,{attributes:true,attributeFilter:["class"]});
if(document.head)o.observe(document.head,{childList:true});}
addEventListener(${JSON.stringify(THEME_CHANGE_EVENT)},sync);
}catch(e){}})();`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: themeScript }} />;
}
