const $ = (s) => document.querySelector(s);
const app = () => document.getElementById("app");
let state = null,
  sync = null;
let curView = "skills",
  current = null;
let currentFile = null,
  currentFileData = null,
  viewMode = "rendered";
// The open vault skill's file listing, kept so the gallery can be drawn from
// what the rail already has instead of asking the server for the skill again.
// The read-only source keeps its own on srcSkill.
let curFiles = [];
// Read-only browse of other skill sources. A source is a runtime (.agents,
// .claude, …); inside it, skills are grouped by what they were installed as.
// "personal" is the managed vault; anything else is view-only.
let curSource = "personal";
let sources = [];
// Whether the source list is split into its groups. On by default: these skills
// arrive in batches, so the batch is how you look for them.
let srcGrouped = true;
// The rail facet in force, as a group key ("" = no filter). Independent of the
// grouping: you can narrow to one plugin in either view.
let srcFilter = "";
// The group of the open source skill. Part of its identity, not decoration: two
// plugins can each ship a "runbook", and the server needs the group to know
// which one to open.
let srcGroup = "";
// The source's skills in the order the list shows them, flattened across
// collections. Arrow navigation in a source detail reads it, so it can leave
// the collection the rail is showing.
let srcOrder = [];
// The open source skill. The file it shows rides on currentFile /
// currentFileData, the same state the vault viewer uses, so setMode and
// renderPlain (highlighting, images, binaries) serve both.
let srcSkill = null;
// Keyboard cursor for the read-only source list: { name, group } of the
// highlighted row (Enter opens). State, so it survives the search re-render.
let srcCursor = null;

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}
async function api(route, body) {
  const opts =
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  const res = await fetch(route, opts);
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { ok: res.ok, status: res.status, data };
}
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2800);
}
function comingSoon(label) {
  toast(label + " — arrives with the next backend step");
}
function confirmActions(title, actions) {
  return new Promise((resolve) => {
    $("#confirm-title").textContent = title;
    $("#confirm-actions").innerHTML = actions
      .map((a) => `<li>${esc(a)}</li>`)
      .join("");
    const dlg = $("#confirm"),
      yes = $("#confirm-yes"),
      no = $("#confirm-no");
    const done = (v) => {
      yes.removeEventListener("click", oy);
      no.removeEventListener("click", on);
      dlg.removeEventListener("close", oc);
      dlg.close();
      resolve(v);
    };
    const oy = () => done(true),
      on = () => done(false);
    // "close" fires as a queued task; see promptDialog for why we gate
    // on dlg.open (only a genuine Esc/backdrop dismissal has it false).
    const oc = () => {
      if (!dlg.open) done(false);
    };
    yes.addEventListener("click", oy);
    no.addEventListener("click", on);
    dlg.addEventListener("close", oc);
    dlg.showModal();
  });
}
// In-app replacement for window.prompt(): resolves to the entered string
// (possibly ""), or null on Cancel / Esc / backdrop — same contract as prompt().
function promptDialog(title, value = "", okLabel = "OK") {
  return new Promise((resolve) => {
    const dlg = $("#prompt"),
      input = $("#prompt-input"),
      yes = $("#prompt-yes"),
      no = $("#prompt-no");
    $("#prompt-title").textContent = title;
    input.value = value ?? "";
    yes.textContent = okLabel;
    const done = (v) => {
      yes.removeEventListener("click", oy);
      no.removeEventListener("click", on);
      dlg.removeEventListener("close", oc);
      input.removeEventListener("keydown", onKey);
      dlg.close();
      resolve(v);
    };
    const oy = () => done(input.value);
    const on = () => done(null);
    // "close" fires as a queued task: when two prompts chain, the first
    // dialog's close lands AFTER the second showModal() and would kill
    // it. A genuine close always has dlg.open === false; ignore the rest.
    const oc = () => {
      if (!dlg.open) done(null);
    };
    const onKey = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        done(input.value);
      }
    };
    yes.addEventListener("click", oy);
    no.addEventListener("click", on);
    dlg.addEventListener("close", oc);
    input.addEventListener("keydown", onKey);
    dlg.showModal();
    input.focus();
    input.select();
  });
}
// Local YYYY-MM-DD for a Date, from local-calendar getters. NOT toISOString(),
// which is UTC and rolls the date over at a different instant than the user's
// clock — misclassifying "today" for ~1-2h around local midnight in zones
// offset from UTC.
function localDateStr(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtWhen(iso, now = new Date()) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  if (iso === localDateStr(now)) return "Today";
  const o = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) o.year = "numeric";
  return d.toLocaleDateString("en-US", o);
}
function fmtLong(iso) {
  if (!iso) return "";
  // A commit datetime carries a "T" (YYYY-MM-DDTHH:MM); a bare date does not.
  // No-offset strings are parsed and rendered in the same (viewer) zone, so the
  // wall-clock the commit recorded is shown verbatim, no timezone shifting.
  const hasTime = iso.includes("T");
  const d = new Date(hasTime ? iso : iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  if (!hasTime) return day;
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return day + ", " + time; // e.g. "July 15, 17:18"
}
// Humanize a kebab value/path. Word casing comes from state.names (built-in
// acronyms/proper nouns merged with the vault's loom.json `names` map);
// otherwise sentence case: first word capitalized, the rest lowercase.
function humanTax(cat) {
  if (cat === "." || cat === "") return "Other";
  const names = (state && state.names) || {};
  return cat
    .split("/")
    .map((seg) =>
      seg
        .split("-")
        .map((w, i) =>
          names[w] !== undefined
            ? names[w]
            : i === 0
              ? w.charAt(0).toUpperCase() + w.slice(1)
              : w,
        )
        .join(" "),
    )
    .join(" / ");
}
// Taxonomy hue palette, kept clear of the state hues (green 160 / amber 68
// / red 25). 16 entries so the largest axis vocabulary gets a distinct hue.
// The stride in taxHueStyle MUST stay coprime with this length: at length 12
// a stride of 3 collapses the palette to 4 hues. gcd(3, 16) = 1.
const TAX_HUES = [
  192, 205, 218, 231, 244, 257, 270, 283, 296, 309, 322, 335, 348, 8, 21, 34,
];
function hueHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
// Taxonomy hue: rank-based over the axis's distinct values (sorted), so up
// to 16 values per axis get 16 DIFFERENT hues (hashing collides). The stride
// (3, coprime with 16) spreads alphabetically-adjacent values far apart on
// the wheel. Same value gets the same hue as a section header and as a
// card chip. Falls back to the hash for unknown/empty values.
// The three custom properties one hue produces.
//
// --tint paints surfaces (tiles, legend dots, map nodes) and keeps a single
// lightness: a fill at 59% reads on both themes. --tint-ink is the same hue as
// TEXT, and text has a contrast floor that one lightness cannot clear on both —
// 59% on the 16% soft fill measured 2.87-3.43 in light and 3.12-3.62 in dark,
// against a 4.5 requirement, across every chip in the library. Only the
// lightness mirrors with the theme; the hue, which is what actually carries the
// taxonomy identity, is the same number in all three properties.
//
// The dark ink sits at 76%, not the 85% it started at. 85 measured 7.77-8.74:1
// against the chip's own fill, where the floor is 4.5 — and it paid for that
// unused margin in chroma: at 85% the 240-260 band clips in gamut around 0.07,
// so half of what a pin asked for was dropped by the browser without saying so,
// which is why the domain column (eight of its sixteen values in that band) read
// visibly quieter than area and kind. Sweeping all 33 values of the three axes
// for the lightness that holds 6:1 lands in a 74-77% band — flat enough to
// collapse to one number. At 76 the full pinned chroma survives (argo, strategy,
// governance and runbook gain ~1.7x) and the chips still measure 5.99-6.63:1.
// Light stays at 41%: it has a clipping problem of its own (13 of the 33 values
// lose chroma there, analytics and operations about half) but that is a separate
// pass, not this one.
function tintVars(hue, chroma = 0.135) {
  // Light steps the ink's chroma down a hair with the fill's, so a deliberately
  // quiet value (slate technology, taupe weddings) stays quiet as text too.
  // Dark does not: at 76% the gamut already holds the pinned chroma, and cutting
  // it again is what made every quiet value collapse toward the same pastel.
  const ink = Math.round(chroma * 0.96 * 1000) / 1000;
  return (
    `--tint:oklch(59% ${chroma} ${hue});` +
    `--tint-soft:oklch(59% ${chroma} ${hue} / 0.16);` +
    `--tint-ink:light-dark(oklch(41% ${ink} ${hue}),oklch(76% ${chroma} ${hue}))`
  );
}
// The vault's pinned hue for an axis value, or null when the axis doesn't pin
// it. Pinned beats rank because rank is unstable: adding one value recolours
// every chip in the library without any skill having changed.
function pinnedHue(axisId, value) {
  const axis = axisList().find((x) => x.id === axisId);
  const spec = axis && axis.hues && axis.hues[value];
  return Array.isArray(spec) ? spec : null;
}
function taxHueStyle(axis, value) {
  const pin = pinnedHue(axis, value);
  if (pin) return tintVars(pin[0], pin[1]);
  const vals = [
    ...new Set((state.skills || []).map((s) => s[axis]).filter(Boolean)),
  ].sort();
  const i = vals.indexOf(value);
  const hue =
    i >= 0
      ? TAX_HUES[(i * 3) % TAX_HUES.length]
      : TAX_HUES[hueHash(value || "other") % TAX_HUES.length];
  return tintVars(hue);
}
// Single source of truth for library grouping + order. renderLibrary and
// libraryOrder (detail arrow-nav) BOTH consume this, so they cannot drift.
function groupKeyOf(s) {
  return groupAxis === "none" ? "" : s[groupAxis] || "";
}
// The axes you are NOT grouping by (all of them in "none" mode), narrowed to
// the ones the set on screen carries: the archive declares three and fills one,
// and a column of nothing but "–" is width spent on an axis that is not there.
function orthAxesOf() {
  return liveAxes()
    .map((a) => a.id)
    .filter((id) => id !== groupAxis);
}
function groupedSkills(skills) {
  const groups = new Map();
  for (const s of skills || libSkills()) {
    const k = groupKeyOf(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  // Within a group: alphabetical by name, or by modified date (ledger
  // column sort). sortDir flips the primary key only. Sections
  // themselves are alphabetical.
  const cmp =
    sortMode === "updated"
      ? (a, b) =>
          sortDir * (a.modified || "").localeCompare(b.modified || "") ||
          a.title.localeCompare(b.title)
      : (a, b) => sortDir * a.title.localeCompare(b.title);
  return [...groups.entries()]
    .map(([key, items]) => ({
      key,
      label: humanTax(key),
      items: items.sort(cmp),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
// The free-text search haystack for a skill: title, name, description and
// every declared taxonomy axis, lowercased. Same fields the rendered
// data-hay attribute holds, so matchesSearch and filterLibrary's DOM check
// stay in lockstep.
function skillHay(s) {
  return (
    s.title +
    " " +
    s.name +
    " " +
    (s.description || "") +
    " " +
    axisList()
      .map((a) => s[a.id] || "")
      .join(" ")
  ).toLowerCase();
}
// The live search query as a pure predicate. libraryOrder() deliberately leaves
// search to the DOM; range-select needs it here so a range can't span skills
// the query has hidden.
function matchesSearch(s) {
  const q = searchQ.trim().toLowerCase();
  return !q || skillHay(s).includes(q);
}
// The rail filters as a pure predicate (search is DOM-only and excluded):
// shared by filterLibrary, libraryOrder (arrow-nav) and the detail rail.
function passesFilters(s) {
  return (
    (!statusFilter || (s.status || "active") === statusFilter) &&
    axisList().every(
      (a) => !axisFilters[a.id] || s[a.id] === axisFilters[a.id],
    ) &&
    (!linkFilter || linkStateOf(s) === linkFilter) &&
    (!syncFilter || (s.sync || "clean") === syncFilter)
  );
}
function libraryOrder() {
  return groupedSkills().flatMap((g) =>
    g.items.filter(passesFilters).map((s) => s.name),
  );
}
// Library order narrowed to the live search too. Range-select (shift+click and
// shift+arrow, both via libSelRange) iterates this so a range stays inside the
// search-visible set. Kept separate from libraryOrder(), which the detail-view
// callers (sibling sort, arrow-nav) need to stay search-agnostic. Note: this
// matches the rail+search filters, not libVisibleEls() — a range spanning a
// collapsed group could still include its hidden items.
function libSelectableOrder() {
  return groupedSkills().flatMap((g) =>
    g.items
      .filter((s) => passesFilters(s) && matchesSearch(s))
      .map((s) => s.name),
  );
}
// Named icons (Lucide-style inner markup; wrapped in a stroke <svg> at use).
// Add a name here + set `icon: <name>` in a skill's frontmatter to use it.
const ICONS = {
  inbox:
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  "file-text":
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  "book-open":
    '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  palette:
    '<path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"/><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>',
  image:
    '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  "pen-tool":
    '<path d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z"/><path d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18"/><path d="m2.3 2.3 7.286 7.286"/><circle cx="11" cy="11" r="2"/>',
  camera:
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  megaphone:
    '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  target:
    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  briefcase:
    '<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/><path d="M2 13h20"/>',
  scale:
    '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  sparkles:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
  mail: '<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/>',
  calendar:
    '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  wallet:
    '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>',
  "dollar-sign":
    '<line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  activity:
    '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  link: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>',
  database:
    '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  "bar-chart":
    '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  wrench:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  "git-branch":
    '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  "git-commit":
    '<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>',
  "map-pin":
    '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  "clipboard-check":
    '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  terminal:
    '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>',
  rocket:
    '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
  feather:
    '<path d="M12.67 19a2 2 0 0 0 1.416-.588l6.154-6.172a6 6 0 0 0-8.49-8.49L5.586 9.914A2 2 0 0 0 5 11.328V18a1 1 0 0 0 1 1z"/><path d="M16 8 2 22"/><path d="M17.5 15H9"/>',
  puzzle:
    '<path d="M4 4h5.5a2.5 2.5 0 0 1 5 0H20v5.5a2.5 2.5 0 0 0 0 5V20H4Z"/>',
  presentation:
    '<path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/>',
  "graduation-cap":
    '<path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  "swatch-book":
    '<path d="M11 17a4 4 0 0 1-8 0V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2Z"/><path d="M16.7 13H19a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7"/><path d="M7 17h.01"/><path d="m11 8 2.3-2.3a2.4 2.4 0 0 1 3.404.014L18.6 7.6a2.4 2.4 0 0 1 .014 3.404L9.9 19.7"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  linkedin:
    '<path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect width="4" height="12" x="2" y="9"/><circle cx="4" cy="4" r="2"/>',
  compass:
    '<path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/><circle cx="12" cy="12" r="10"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  handshake:
    '<path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.24L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/>',
  heart:
    '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  coins:
    '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  notebook:
    '<path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M15 2v20"/>',
  "audio-lines":
    '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>',
  "heart-pulse":
    '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.22 8H9.5l.5-1 2 4 .5-1h5.27"/>',
  history:
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  move: '<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="22"/>',
  "list-checks":
    '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  package:
    '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73Z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/>',
  fallback:
    '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
};
// Tailwind-ish named colors → OKLCH. Fixed (theme-independent), like NotePlan.
const NC_HUE = {
  red: 25,
  orange: 52,
  amber: 75,
  yellow: 100,
  lime: 125,
  green: 150,
  emerald: 165,
  teal: 182,
  cyan: 205,
  sky: 230,
  blue: 255,
  indigo: 274,
  violet: 292,
  purple: 310,
  fuchsia: 328,
  pink: 348,
  rose: 12,
  slate: 250,
  gray: 255,
  grey: 255,
  zinc: 270,
  neutral: 250,
  stone: 60,
};
const NC_NEUTRAL = new Set([
  "slate",
  "gray",
  "grey",
  "zinc",
  "neutral",
  "stone",
]);
function namedColor(token) {
  if (!token) return null;
  // The step suffix (-400/-500/-600) is legacy: accepted so existing
  // frontmatter keeps parsing, ignored so it no longer modulates anything.
  // The token carries a HUE (and the neutral flag); lightness and chroma
  // belong to the tile system, or an override renders one weight and an
  // inherited tile another — the exact mismatch this replaced.
  const m = String(token)
    .trim()
    .toLowerCase()
    .match(/^([a-z]+)(?:-(\d{3}))?$/);
  if (!m) return null;
  const hue = NC_HUE[m[1]];
  if (hue === undefined) return null;
  return { hue, neutral: NC_NEUTRAL.has(m[1]) };
}
// Icon inner markup: prefer the full generated Lucide catalog (icons.js), then
// the built-in handwritten map, then the generic glyph. The catalog is absent in
// unit tests and if icons.js failed to load, so the fallbacks are load-bearing.
function iconInner(nm) {
  const cat = globalThis.SKILL_LOOM_ICONS;
  return (cat && cat[nm]) || ICONS[nm] || ICONS.fallback;
}
// An explicit product colour always wins over the taxonomy, including a
// neutral one. The gate now permits icon-color only for whitelisted products,
// so neutral-500 is a deliberate black-gray brand mark, not a scaffold default.
function chosenColor(iconColor) {
  return namedColor(iconColor);
}

function skillTile(s) {
  const nm = (s.icon || "").trim();
  const col = chosenColor(s.iconColor);
  // No chosen icon-color: the tile inherits the hue of the axis loom.json
  // marks with `tile: true` (the area) — identical to that axis's chip by
  // construction. icon-color survives purely as the product override
  // (LinkedIn blue, npm red): the one case where the tile knows better than
  // the taxonomy.
  let style = "";
  if (col) style = ` style="${tintVars(col.hue, col.neutral ? 0 : 0.135)}"`;
  else {
    const axis = axisList().find((x) => x.tile);
    const pin = axis && pinnedHue(axis.id, s[axis.id]);
    if (pin) style = ` style="${tintVars(pin[0], pin[1])}"`;
  }
  if (nm) {
    const inner = iconInner(nm);
    return `<span class="tile"${style}><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg></span>`;
  }
  const mono = ((s.name || "?").match(/[a-z0-9]/i) || ["?"])[0];
  return `<span class="tile mono"${style}>${esc(mono.toUpperCase())}</span>`;
}
// Small colored glyph for dense lists (rail sibling list) — no tile box.
function railIcon(s) {
  const nm = (s.icon || "").trim();
  const col = chosenColor(s.iconColor);
  // Same colour story as the library tile: chosen icon-color wins, otherwise
  // the area tint. The rail used to stay neutral by design ("the vault is
  // flat") while the grid tinted by area — the same skill read colored in one
  // view and gray in the other, which is worse than either choice alone.
  let hue = col && [col.hue, col.neutral ? 0 : 0.135];
  if (!hue) {
    const axis = axisList().find((x) => x.tile);
    hue = axis && pinnedHue(axis.id, s[axis.id]);
  }
  const style = hue ? `${tintVars(hue[0], hue[1])};color:var(--tint)` : "";
  // No frontmatter icon falls back to the initial, the same way the library
  // tile does. Read-only sources carry no icon: at all, so the generic glyph
  // made every row in the rail identical and told the reader nothing.
  if (!nm)
    return `<span class="fic mono" style="${style}">${mono(s.name)}</span>`;
  return `<span class="fic" style="${style}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconInner(nm)}</svg></span>`;
}
function fmtSize(n) {
  return n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB";
}
const FILEICONS = {
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9z"/><path d="M13 3v6h6"/><path d="M8.5 13l1.6 3 1.9-4 1.6 4 1.4-2"/></svg>',
  config:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4c-2 .2-2 2-2 4s-.2 3.6-2 4c1.8 .4 2 2 2 4s0 3.8 2 4"/><path d="M15 4c2 .2 2 2 2 4s.2 3.6 2 4c-1.8 .4-2 2-2 4s0 3.8-2 4"/></svg>',
  script:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9z"/><path d="M13 3v6h6"/><path d="M9 13h6M9 17h4"/></svg>',
};
// The gallery's own glyph, in the rail's stroke weight. Not from FILEICONS:
// that table answers "what kind of file is this", and the gallery is not one.
const GALLERY_IC =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="16" height="16" rx="2"/><circle cx="12" cy="8" r="1.6"/><path d="M22 13l-1.3-1.3a2.4 2.4 0 0 0-3.4 0L11 18"/><path d="M18 22H4a2 2 0 0 1-2-2V6"/></svg>';
// The file's own export sits next to the file's own name: it takes what the
// viewer is showing, while the header's Export takes the whole skill as a zip.
// Icon-only because the bar is a caption for the document, not a toolbar — the
// name rides on title and aria-label. Hidden until a file is actually open.
const FILE_EXPORT_BTN =
  `<button class="icon" id="v-export" title="Export this file" aria-label="Export this file" hidden>` +
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg></button>`;
function fileIcon(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  const t =
    ext === "md"
      ? "doc"
      : ["yaml", "yml", "json", "toml"].includes(ext)
        ? "config"
        : ["py", "sh", "js", "ts", "mjs", "cjs", "rb", "go"].includes(ext)
          ? "script"
          : "text";
  return `<span class="fic">${FILEICONS[t]}</span>`;
}
// Runtime/consumer label: apply the shared casing map (OpenClaw, GitHub,
// …) from state.names, title-casing any remaining words. Keeps consumer
// names consistent with server-humanized skill titles.
function rtName(name) {
  const names = (state && state.names) || {};
  return String(name)
    .split("-")
    .map((w) => {
      const lw = w.toLowerCase();
      return names[lw] !== undefined
        ? names[lw]
        : w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const CHECK =
  '<svg viewBox="0 0 12 12" fill="none"><path d="M2 6.5l2.5 2.5L10 3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const WARNI =
  '<svg viewBox="0 0 12 12" fill="none"><path d="M6 3v3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="6" cy="9" r=".9" fill="currentColor"/></svg>';
function healthBadge(health, extra) {
  if (health === "active")
    return `<span class="badge ok">${CHECK}${esc(extra || "All linked")}</span>`;
  if (health === "attention")
    return `<span class="badge warn" title="Runtime links need attention">${WARNI}${esc(extra || "Attention")}</span>`;
  return `<span class="badge off" title="Not linked into any runtime yet">${esc(extra || "Not active")}</span>`;
}

/* ---------- routing ---------- */
function setFixed(f) {
  document.body.classList.toggle("fixed", f);
}
function updateNav() {
  $("#nav-skills").classList.toggle(
    "on",
    curView === "skills" ||
      curView === "detail" ||
      curView === "archived" ||
      curView === "new" ||
      curView === "empty",
  );
  $("#nav-status").classList.toggle("on", curView === "status");
  $("#nav-config").classList.toggle("on", curView === "config");
}
function go(view, arg) {
  // Each Markdown file chooses its own default when opened. Entering detail
  // starts neutral; showFile applies the file-specific default after loading.
  if (view === "detail" && curView !== "detail") viewMode = "rendered";
  if (view === "config" && curView !== "config") configPane = "rules";
  curView = view;
  if (view !== "detail") current = null;
  render(arg);
}
// Each navigation bumps navSeq. Async views (which await a fetch before
// painting) capture it and bail if a newer navigation started meanwhile,
// so a slow render can never overwrite a fresher view.
let navSeq = 0;
let lastView = null;
function navStart() {
  const p = $("#navprog");
  if (!p) return;
  p.classList.remove("done", "loading");
  // Snap to width 0 with no transition, then start the fill. Without this,
  // a fast previous nav can leave the bar near 100%, and the base 0.2s
  // width transition would animate the reset from that high value, so
  // .loading then runs backwards (right to left) before completing.
  p.style.transition = "none";
  p.style.width = "0";
  void p.offsetWidth; // commit the 0-width, transition-less state
  p.style.transition = "";
  p.classList.add("loading");
}
function navStop() {
  const p = $("#navprog");
  if (!p || !p.classList.contains("loading")) return;
  p.classList.remove("loading");
  p.classList.add("done");
}
// True while the given nav is still the current one. Async renders call this
// after each await, before touching the DOM.
function navCurrent(seq) {
  return seq == null || seq === navSeq;
}
// The archive paints through renderLibrary, so as far as the fade is concerned
// it is the same surface as the library: moving between them changes the set on
// screen, not the view, and fading the whole thing reads as a flash.
function fadeSurface(v) {
  return v === "archived" ? "skills" : v;
}
function render(arg) {
  const seq = ++navSeq;
  updateNav();
  // Freeze the outgoing view before touching the fade class. Dropping
  // "norefade" re-arms loomfade on the children still on screen, and an async
  // view (detail, status, config) leaves them there long enough to blink to
  // zero and fade back in before the new content lands. The incoming children
  // carry no inline style, so they still follow the rule below.
  for (const k of app().children) k.style.animation = "none";
  // Skip the view fade on a same-view refresh (data reload): only the
  // content changes, the background stays put (no flash).
  app().classList.toggle(
    "norefade",
    fadeSurface(curView) === fadeSurface(lastView),
  );
  lastView = curView;
  const isAsync =
    curView === "detail" || curView === "status" || curView === "config";
  if (isAsync) navStart();
  else navStop();
  if (curView === "skills")
    // A non-vault source is browsed read-only; the vault keeps its first-run
    // hero on an empty library, and archived mode renders its own list.
    curSource !== "personal"
      ? renderSourceLibrary(seq)
      : (state.skills || []).length === 0 && !libArchived
        ? renderEmpty()
        : renderLibrary();
  else if (curView === "detail")
    curSource !== "personal"
      ? renderSourceDetail(arg || current, seq)
      : renderDetail(arg || current, seq);
  else if (curView === "status") renderStatus(seq);
  else if (curView === "new") renderNew();
  else if (curView === "config") renderConfig(seq);
  else if (curView === "archived") renderArchived();
  else if (curView === "empty") renderEmpty();
}

/* ---------- library ---------- */
let searchQ = "";
let syncBannerDismissed = false;
// How the library is grouped is a standing preference, not a per-visit choice:
// a vault is read the same way every time it is opened, and re-picking the axis
// on every load was the first thing done in every session. Stored per source,
// because the axes a source declares are its own.
const GROUP_KEY = "skill-loom:group";
let groupAxis = "none"; // "none" | a declared axis id
function groupStoreKey() {
  return `${GROUP_KEY}:${curSource || "personal"}`;
}
function loadGroupAxis() {
  try {
    groupAxis = localStorage.getItem(groupStoreKey()) || "none";
  } catch {
    // private mode / storage disabled: this session keeps its own choice
    groupAxis = "none";
  }
}
function setGroupAxis(axis) {
  groupAxis = axis;
  try {
    localStorage.setItem(groupStoreKey(), axis);
  } catch {
    // nothing to persist to; the choice still holds for this page
  }
}
let sortMode = "name"; // "name" | "axis" (orthogonal taxonomy axis) | "updated"
let sortDir = 1; // 1 asc, -1 desc (toggled by ledger column headers)
// Which of the three modes the library opens in is a standing preference, the
// same as the grouping: whoever reads the vault as a map reads it as a map
// every morning. Stored per source alongside the axis.
const VIEW_KEY = "skill-loom:view";
const LIB_VIEWS = ["grid", "list", "map"];
let libView = "list"; // "grid" | "list" | "map"
function viewStoreKey() {
  return `${VIEW_KEY}:${curSource || "personal"}`;
}
function loadLibView() {
  let v = null;
  try {
    v = localStorage.getItem(viewStoreKey());
  } catch {
    // private mode / storage disabled: this session keeps its own choice
  }
  applyLibView(LIB_VIEWS.includes(v) ? v : "list");
}
// Leaving the map closes whatever the inspector had drilled into. A selection
// is a place on the canvas and survives the round trip; a panel opened from a
// findings row is a step away from the summary, and coming back to the map
// mid-list is not where the map starts.
function applyLibView(v) {
  libView = v;
  if (v !== "map") mapPanel = null;
}
// The persisting form is for a mode the user picked. The archive's fallback off
// the map is about the set on screen, so it uses applyLibView and leaves the
// preference alone — the way back out restores it.
function setLibView(v) {
  applyLibView(v);
  try {
    localStorage.setItem(viewStoreKey(), v);
  } catch {
    // nothing to persist to; the choice still holds for this page
  }
}
let libArchived = false; // library shows the archive instead of active skills
// The statuses the set on screen actually holds, in lifecycle order — the same
// list the rail renders, so the keyboard walks exactly what the eye can click.
function presentStatuses() {
  const seen = new Set(libSkills().map((s) => s.status || "active"));
  return STATUS_ORDER.filter((v) => seen.has(v)).concat(
    [...seen].filter((v) => !STATUS_ORDER.includes(v)),
  );
}
// The status facet from the keyboard: no filter, then each status in turn,
// then no filter again. "All" is a stop on the ring rather than something you
// escape by pressing the same value twice, so one key both narrows and clears.
function cycleStatusFilter() {
  const ring = [null, ...presentStatuses()];
  if (ring.length < 2) return;
  // A filter on a status the set no longer holds lands at -1, which steps to
  // "all" instead of getting stuck past the end.
  const next = ring[(ring.indexOf(statusFilter) + 1) % ring.length] ?? null;
  setStatusFilter(next);
  if (mapPanel) repaintLibrary();
  else {
    const rail = $("#librail");
    if (rail) rail.innerHTML = renderRailHtml();
    if (libView === "map") paintMap();
    else filterLibrary();
  }
  toast(next ? `Status: ${statusLabel(next)}` : "Status: all");
}
// The set the library renders: active vault skills, or archived ones as
// cards (same UI). All library machinery reads through this.
function libSkills() {
  return libArchived ? archivedCards() : state.skills || [];
}
// Entering or leaving the archive swaps the set every rail control describes,
// so the controls that cannot survive the swap go with it: a filter naming a
// value the other set does not carry would empty the view from a control that
// no longer lists it, and the archive has no graph to map. The map mode is
// remembered rather than discarded — leaving the archive puts you back on the
// view you came from.
let viewBeforeArchive = null;
function setLibArchived(next) {
  if (libArchived === next) return;
  libArchived = next;
  clearRailFilters(false);
  mapSel = null;
  mapLens = null;
  if (next) {
    // Only the map is stepped off, and only then is anything remembered: a
    // mode picked inside the archive is a choice, and it survives the way out.
    viewBeforeArchive = libView === "map" ? "list" : null;
    if (libView === "map") applyLibView("list");
  } else {
    if (viewBeforeArchive && libView === viewBeforeArchive) applyLibView("map");
    viewBeforeArchive = null;
  }
  // The archive carries one axis of the three and its own statuses, so both
  // fall back while you are in there. Re-read the stored preferences on the
  // way out: the fallback is for the set on screen, not a change of mind.
  loadGroupAxis();
  normalizeGroupAxis();
  if (!next) loadStatusFilter();
}
// The 'a' shortcut toggles the library between active and archived. Return
// the next libArchived AND the view that matches it, so the handler can
// route through go() and keep curView in sync. A bare flip + renderLibrary
// left curView stale, and any later render() re-dispatched on curView and
// snapped the view back, discarding the toggle.
function archiveToggleTarget(archived) {
  const next = !archived;
  return { libArchived: next, view: next ? "archived" : "skills" };
}
// The vault's declared axes, straight from the server. Everything taxonomy-
// shaped in the UI reads these instead of naming an axis.
function axisList() {
  return (state && state.axes) || [];
}
function axisLabel(id) {
  const a = axisList().find((x) => x.id === id);
  return (a && a.label) || humanTax(id);
}
// axis id -> selected value. Replaces domainFilter / layerFilter.
let axisFilters = {};
let statusFilter = null; // null = all, else a status value
let linkFilter = null; // null = all, else a link state
let syncFilter = null; // null = all, else a sync state (internal value)
// The rail's filters as a predicate over a skill. filterLibrary() applies the
// same rules to the DOM, which is all a table or a grid needs; the map has no
// rows to hide, so it has to filter the set it draws from. Both read this, so
// a rail selection cannot mean one thing in the ledger and another on the map.
function passesFilters(s) {
  if (statusFilter && (s.status || "active") !== statusFilter) return false;
  if (linkFilter && linkStateOf(s) !== linkFilter) return false;
  if (syncFilter && (s.sync || "clean") !== syncFilter) return false;
  return axisList().every(
    (a) => !axisFilters[a.id] || (s[a.id] || "") === axisFilters[a.id],
  );
}
function filteredSkills() {
  return libSkills().filter(passesFilters);
}
function anyFilterOn() {
  return !!(
    statusFilter ||
    linkFilter ||
    syncFilter ||
    axisList().some((a) => axisFilters[a.id])
  );
}
// Switching between the active library and the archive switches the set the
// rail describes: a domain the archive does not carry, or a status only live
// skills take, would silently empty the view with a control that no longer
// lists the value it is filtering on.
function clearRailFilters(persist = true) {
  axisFilters = {};
  setStatusFilter(null, persist);
  linkFilter = null;
  syncFilter = null;
}
// Which lifecycle status the library is filtered to is a standing preference,
// like the grouping axis and the mode: someone who works out of the drafts
// opens on the drafts. Stored per source alongside the other two.
const STATUS_KEY = "skill-loom:status";
function statusStoreKey() {
  return `${STATUS_KEY}:${curSource || "personal"}`;
}
function loadStatusFilter() {
  try {
    statusFilter = localStorage.getItem(statusStoreKey()) || null;
  } catch {
    // private mode / storage disabled: this session keeps its own choice
    statusFilter = null;
  }
}
// persist=false is for the fallbacks that are about the set on screen rather
// than a change of mind — crossing into the archive, whose statuses are its
// own. The preference survives the trip and the way back restores it.
function setStatusFilter(v, persist = true) {
  statusFilter = v;
  if (!persist || libArchived) return;
  try {
    if (v) localStorage.setItem(statusStoreKey(), v);
    else localStorage.removeItem(statusStoreKey());
  } catch {
    // nothing to persist to; the choice still holds for this page
  }
}
// A stored status the current set does not hold would filter the library down
// to nothing from a facet the rail no longer lists. Fall back to no filter for
// this render, without touching what is stored: the status may well be back
// after the next edit.
function normalizeStatusFilter() {
  if (statusFilter && !presentStatuses().includes(statusFilter))
    statusFilter = null;
}
// keyboard selection over the (grid) card list: arrows move, Enter opens
let libSelName = null;
function libHighlight(name) {
  libSelName = name;
  const all = [...document.querySelectorAll("#groups [data-skill]")];
  all.forEach((c) => c.classList.toggle("kbsel", c.dataset.skill === name));
  all
    .find((c) => c.dataset.skill === name)
    ?.scrollIntoView({ block: "nearest" });
}
function libDeselect() {
  libSelName = null;
  document
    .querySelectorAll("#groups .card.kbsel")
    .forEach((c) => c.classList.remove("kbsel"));
}
// Multi-select for bulk actions (distinct from libSelName, the keyboard cursor).
let libSel = new Set();
let libSelAnchor = null;
// Set true when a marquee drag ends, to swallow the click it would emit.
let suppressClickOnce = false;
function libSelApply() {
  document
    .querySelectorAll("#groups [data-skill]")
    .forEach((c) => c.classList.toggle("sel", libSel.has(c.dataset.skill)));
}
function libToggleSel(name) {
  if (libSel.has(name)) libSel.delete(name);
  else libSel.add(name);
  libSelAnchor = name;
  libSelApply();
}
// Contiguous range anchor..name (rebuilt each call, so Shift+arrow shrinks
// as well as grows and Shift+click reselects a clean range).
function libSelRange(name) {
  const order = libSelectableOrder();
  const a = order.indexOf(libSelAnchor ?? name);
  const b = order.indexOf(name);
  if (a < 0 || b < 0) return libToggleSel(name);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  libSel = new Set(order.slice(lo, hi + 1));
  libSelApply();
}
function libSelClear() {
  libSel.clear();
  libSelAnchor = null;
  libSelApply();
}
// Visible [data-skill] elements in DOM order (grid cards AND list rows),
// excluding filtered-out/hidden ones. Shared by arrow-nav, select-all and
// marquee drag-select.
function libVisibleEls() {
  return [...document.querySelectorAll("#groups [data-skill]")].filter(
    (c) => !c.hidden && c.offsetParent !== null,
  );
}
function libSelectAllVisible() {
  const els = libVisibleEls();
  const names = els.map((c) => c.dataset.skill);
  libSel = new Set(names);
  if (names.length) {
    libSelAnchor = names[0];
    // Put the cursor at the end (so a following Shift+arrow extends from
    // there) but do NOT scroll — select-all stays in the current view.
    libSelName = names[names.length - 1];
    els.forEach((c) => c.classList.toggle("kbsel", c === els[els.length - 1]));
  }
  libSelApply();
}
// Arrow navigation drives the selection: a plain arrow moves a single-row
// selection cursor; Shift+arrow extends the multi-selection from the
// anchor. Works in both list (linear) and grid (spatial up/down) views.
function libNav(key, shift) {
  const els = libVisibleEls();
  if (!els.length) return;
  // A list is one column: only Up/Down move in it. Left/Right belong to the
  // grid, where they mean something spatially. Checked before the no-cursor
  // case, or a sideways key would drop a cursor on the first row.
  if (libView === "list" && (key === "ArrowLeft" || key === "ArrowRight"))
    return;
  const idx = els.findIndex((c) => c.dataset.skill === libSelName);
  let ni;
  if (idx < 0) {
    ni = 0;
  } else if (libView === "list") {
    const step = key === "ArrowUp" ? -1 : 1;
    ni = Math.min(els.length - 1, Math.max(0, idx + step));
  } else if (key === "ArrowLeft") {
    ni = Math.max(0, idx - 1);
  } else if (key === "ArrowRight") {
    ni = Math.min(els.length - 1, idx + 1);
  } else {
    // grid up/down: nearest card by x in the adjacent row
    const meta = els.map((c) => {
      const r = c.getBoundingClientRect();
      return { top: Math.round(r.top), cx: r.left + r.width / 2 };
    });
    const cur = meta[idx];
    const tops = [...new Set(meta.map((m) => m.top))].sort((a, b) => a - b);
    const targetTop =
      tops[tops.indexOf(cur.top) + (key === "ArrowDown" ? 1 : -1)];
    if (targetTop === undefined) return;
    ni = -1;
    for (let i = 0; i < meta.length; i++)
      if (
        meta[i].top === targetTop &&
        (ni < 0 ||
          Math.abs(meta[i].cx - cur.cx) < Math.abs(meta[ni].cx - cur.cx))
      )
        ni = i;
    if (ni < 0) return;
  }
  const name = els[ni].dataset.skill;
  if (shift) {
    if (libSelAnchor == null) libSelAnchor = libSelName || name;
    libSelRange(name);
  } else {
    libSel = new Set([name]);
    libSelAnchor = name;
    libSelApply();
  }
  libHighlight(name);
}
const LIFECYCLE_LABEL = {
  idea: "Idea",
  draft: "Draft",
  active: "Active",
  suspended: "Suspended",
  deprecated: "Deprecated",
};
function statusLabel(s) {
  return LIFECYCLE_LABEL[s] || humanTax(s);
}
// Lifecycle chip, same filled style as the Links/Sync chips. The grid
// stays exception-only (active shows nothing); the ledger passes
// showActive to state every row.
const LIFECYCLE_CLS = {
  idea: "off",
  draft: "draft",
  active: "ok",
  suspended: "warn",
  deprecated: "bad",
};
function statusBadge(status, showActive) {
  const st = status || "active";
  if (st === "active")
    return showActive ? `<span class="badge ok">active</span>` : "";
  const cls = LIFECYCLE_CLS[st] || "off";
  return `<span class="badge ${cls}">${esc(statusLabel(st).toLowerCase())}</span>`;
}
// Colored via taxHueStyle (rank-based per axis), so each axis value reads
// with its own hue at a glance and matches its section accent.
function taxChip(axis, v) {
  // The label rides in its own span so a narrow column can ellipsize it, and
  // the title carries the full value for the ones that do get clipped.
  const label = humanTax(v);
  return `<span class="taxchip" style="${taxHueStyle(axis, v)}" title="${esc(label)}"><span class="tcdot"></span><span class="tclabel">${esc(label)}</span></span>`;
}
// Orthogonal axis chip(s): the axes you are NOT grouping by. "none" shows all.
function orthChips(s) {
  return orthAxesOf()
    .filter((id) => s[id])
    .map((id) => taxChip(id, s[id]))
    .join("");
}
// Per-axis data attributes, so filterLibrary's DOM check can match on any
// declared axis without naming one. Shared by the grid card and the ledger
// row — both are [data-skill] elements filterLibrary walks identically.
function axisDataAttrs(s) {
  return axisList()
    .map((a) => `data-${a.id}="${esc(s[a.id] || "")}"`)
    .join(" ");
}
function libCard(s) {
  const hay = skillHay(s);
  const chips = orthChips(s);
  const badges = statusBadge(s.status);
  // Grouped, each section has its own h2 and the card title sits under it.
  // Ungrouped there is no section, so an h3 would skip a level below the page's
  // h1 and the document outline would read as a gap.
  const h = groupAxis === "none" ? "h2" : "h3";
  const foot =
    chips || badges
      ? `<div class="foot"><span class="foot-l">${chips}</span><span class="foot-r">${badges}</span></div>`
      : "";
  return `<a class="card${libSel.has(s.name) ? " sel" : ""}" data-skill="${esc(s.name)}" data-hay="${esc(hay)}" ${axisDataAttrs(s)} data-status="${esc(s.status || "active")}" ${libArchived ? "" : `data-link="${esc(linkStateOf(s))}" data-sync="${esc(s.sync || "clean")}"`}><span class="selbox" aria-hidden="true"></span><div class="top">${skillTile(s)}<div class="headwrap"><${h}>${esc(s.title)}</${h}></div><span class="when">${esc(fmtWhen(s.modified))}</span></div><p>${esc(s.description || "No description yet.")}</p>${foot}</a>`;
}
// Command rail: Group switch + one section per declared axis, plus Status.
// Counts are a snapshot of the whole vault, not of the current filter.
const STATUS_ORDER = ["idea", "draft", "active", "suspended", "deprecated"];
const STATUS_DOT = {
  idea: "var(--faint)",
  draft: "var(--draft)",
  active: "var(--ok)",
  suspended: "var(--warn)",
  deprecated: "var(--err)",
};
function axisValues(axis) {
  return [
    ...new Set(
      libSkills()
        .map((s) => s[axis])
        .filter(Boolean),
    ),
  ].sort();
}
// The declared axes that the set on screen actually carries. The vault
// declares three; the archive fills one, so grouping or filtering the archive
// by the other two offers a control with no value behind it.
function liveAxes() {
  return axisList().filter((a) => axisValues(a.id).length);
}
// Grouping by an axis the current set does not carry puts every skill in one
// nameless bucket. Fall back to no grouping instead, and keep the fallback
// where the rail can see it: the segmented control reads groupAxis.
function normalizeGroupAxis() {
  if (groupAxis !== "none" && !liveAxes().some((a) => a.id === groupAxis))
    groupAxis = "none";
}
function renderRailHtml() {
  const counts = (axis) => {
    const m = {};
    for (const s of libSkills()) {
      const v = axis === "status" ? s.status || "active" : s[axis];
      if (v) m[v] = (m[v] || 0) + 1;
    }
    return m;
  };
  const seg = (a, lbl) =>
    `<button data-axis="${esc(a)}"${groupAxis === a ? ' class="on"' : ""} type="button">${esc(lbl)}</button>`;
  const item = (kind, v, label, count, on, style) =>
    `<button class="ritem${on ? " on" : ""}" data-kind="${kind}" data-v="${esc(v)}" style="${style}" type="button"><span class="d"></span>${esc(label)}<span class="n">${count}</span></button>`;
  const sc = counts("status");
  const kc = {};
  const yc = {};
  for (const sk of libSkills()) {
    const k = linkStateOf(sk);
    kc[k] = (kc[k] || 0) + 1;
    const y = sk.sync || "clean";
    yc[y] = (yc[y] || 0) + 1;
  }
  const statuses = STATUS_ORDER.filter((s) => sc[s]).concat(
    Object.keys(sc).filter((s) => !STATUS_ORDER.includes(s)),
  );
  // A heading with nothing under it is not a quiet section, it is a label for
  // an empty set: the archive declares three axes and carries values for one,
  // and the other two used to print a title over nothing.
  const section = (label, rows) =>
    rows ? `<div class="rl">${esc(label)}</div>${rows}` : "";
  const axisSections = liveAxes()
    .map((a) => {
      const c = counts(a.id);
      return section(
        axisLabel(a.id),
        axisValues(a.id)
          .map((v) =>
            item(
              a.id,
              v,
              humanTax(v),
              c[v],
              axisFilters[a.id] === v,
              taxHueStyle(a.id, v),
            ),
          )
          .join(""),
      );
    })
    .join("");
  // Links and sync describe where a skill is served and whether the vault has
  // it committed. An archived skill is served nowhere, and the archive rows
  // carried a fabricated "partial / synced" for both.
  const stateSections = libArchived
    ? ""
    : section(
        "Links",
        LINK_ORDER.filter((v) => kc[v])
          .map((v) =>
            item(
              "link",
              v,
              cap(v),
              kc[v],
              linkFilter === v,
              `--tint:${LINK_DOT[v]}`,
            ),
          )
          .join(""),
      ) +
      section(
        "Sync",
        SYNC_ORDER.filter((v) => yc[v])
          .map((v) =>
            item(
              "sync",
              v,
              cap(SYNC_LABEL[v]),
              yc[v],
              syncFilter === v,
              `--tint:${SYNC_DOT[v]}`,
            ),
          )
          .join(""),
      );
  const groupBy = liveAxes().length
    ? `<div class="rl">Group by</div><div class="seg" id="groupby">${seg("none", "None")}${liveAxes()
        .map((a) => seg(a.id, axisLabel(a.id)))
        .join("")}</div>`
    : "";
  return (
    groupBy +
    mapRailHtml() +
    axisSections +
    section(
      "Status",
      statuses
        .map((v) =>
          item(
            "status",
            v,
            statusLabel(v),
            sc[v],
            statusFilter === v,
            `--tint:${STATUS_DOT[v] || "var(--dim)"}`,
          ),
        )
        .join(""),
    ) +
    stateSections
  );
}
/* ---------- map view ---------- */
// The knowledge graph is concept-level: thousands of nodes, which on screen is
// a hair ball and tells you nothing you can act on. The map draws the unit the
// library already governs — one circle per skill, inside its group — and keeps
// the concepts for the inspector.
const MAP_CELL = 74;
const MAP_ROWH = 84;
const MAP_PADX = 14;
const MAP_HEAD = 26;
const MAP_GAP = 16;

let graphData = null;
let graphState = "idle"; // idle | loading | error
let mapSel = null; // {t:"s",k} | {t:"e",a,b} | {t:"m",a,b}
let mapLens = null; // unlinked | coupled | dupes | code
let mapMentions = false;
// The inspector shows one thing at a time: the summary, what you picked on the
// canvas, or a finding's own list opened from the row that counts it.
let mapPanel = null; // null | "weak" — the map, or a finding's own list in place of it

// A family is the name prefix before the first dash, the same rule the
// extraction pipeline uses to decide what it can see at once.
function famOf(name) {
  const cut = name.indexOf("-");
  return cut === -1 ? name : name.slice(0, cut);
}

// Inside a group every name repeats the same prefix, so the label carries
// nothing until it goes. Put it back wherever stripping would make two skills
// read the same: five skills labelled "brand-system" is worse than long names.
function mapLabels(names) {
  // Strip the skill's own taxonomy value, not the family: the family is the
  // name prefix, so stripping it turns artifact-versioning into "versioning"
  // and loses the subject. The first declared axis is the one the vault names
  // its skills after (bottega19-ads-review), and where it does not prefix the
  // name nothing is removed.
  const axis = (axisList()[0] || {}).id;
  const valueOf = (n) => {
    const sk = (state.skills || []).find((s) => s.name === n);
    return (axis && sk && sk[axis]) || "";
  };
  const strip = (n) => {
    const v = valueOf(n);
    return v && n.startsWith(v + "-") && n.length > v.length + 1
      ? n.slice(v.length + 1)
      : n;
  };
  const seen = {};
  for (const n of names) {
    const s = strip(n);
    seen[s] = (seen[s] || 0) + 1;
  }
  const out = {};
  for (const n of names) {
    const s = strip(n);
    const label = seen[s] > 1 ? n : s;
    out[n] = label.length > 14 ? label.slice(0, 13) + "…" : label;
  }
  return out;
}

// One field's box and the grid of skills inside it. The grid is centred in the
// box, and so is a row that does not fill it: a group of one would otherwise
// sit in the top-left corner of a field sized for three, which reads as broken
// rather than as small.
function mapField(g, x, y, w, cols) {
  const n = g.items.length;
  const rows = Math.ceil(n / cols);
  const h = rows * MAP_ROWH + MAP_HEAD + 14;
  const grid = x + (w - cols * MAP_CELL) / 2;
  const pos = {};
  g.items.forEach((s, i) => {
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, n - row * cols);
    const indent = ((cols - inRow) * MAP_CELL) / 2;
    pos[s.name] = {
      x: grid + indent + (i % cols) * MAP_CELL + MAP_CELL / 2,
      y: y + MAP_HEAD + 8 + row * MAP_ROWH + 26,
    };
  });
  return { key: g.key, label: g.label, items: g.items, x, y, w, h, pos };
}

// Grouping off: one field, and it takes the width it is given instead of
// staying a narrow column with dead space beside it.
function mapSingleField(g, width) {
  const fits = Math.max(
    2,
    Math.floor((width - 2 * MAP_GAP - 2 * MAP_PADX) / MAP_CELL),
  );
  const cols = Math.max(2, Math.min(fits, g.items.length));
  const box = mapField(
    g,
    MAP_GAP,
    MAP_GAP,
    cols * MAP_CELL + MAP_PADX * 2,
    cols,
  );
  return { boxes: [box], height: box.y + box.h + MAP_GAP };
}

// Deterministic layout: each group is a field, skills sit on a grid inside it,
// and the fields stack in columns of one width — each new field dropped into
// the column that is currently shortest.
//
// Fields used to flow across the canvas and wrap, which made every row as tall
// as its tallest field: a 3-skill field beside a 9-skill one carried a whole
// field of nothing under it, and on the real vault 42% of the canvas was empty
// while the map still needed 1388px of scroll. Columns close that gap without
// giving up the property that matters — no force simulation, so the same vault
// draws the same map twice and a node can be pointed at in a conversation.
function mapLayout(groups, width) {
  if (groups.length === 1) return mapSingleField(groups[0], width);
  // Column count comes from a three-skill field; the width left over is then
  // shared out, so the columns always span the canvas exactly.
  const ideal = 3 * MAP_CELL + MAP_PADX * 2;
  const ncols = Math.max(1, Math.floor((width - MAP_GAP) / (ideal + MAP_GAP)));
  const colW = Math.floor((width - MAP_GAP * (ncols + 1)) / ncols);
  const cols = Math.max(1, Math.floor((colW - MAP_PADX * 2) / MAP_CELL));
  // Biggest first: the columns only close level if the tall fields are placed
  // while there is still room to balance them. This is the map's own order, not
  // the library's — a group is looked up in the rail, which lists every value
  // alphabetically with its count.
  const ordered = [...groups].sort(
    (a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label),
  );
  const colY = new Array(ncols).fill(MAP_GAP);
  const boxes = [];
  for (const g of ordered) {
    let c = 0;
    for (let i = 1; i < ncols; i++) if (colY[i] < colY[c]) c = i;
    const box = mapField(
      g,
      MAP_GAP + c * (colW + MAP_GAP),
      colY[c],
      colW,
      cols,
    );
    boxes.push(box);
    colY[c] = box.y + box.h + MAP_GAP;
  }
  return { boxes, height: Math.max(...colY) };
}

// Size carries how much was extracted from a skill, so a thin skill looks thin.
function mapRadius(name) {
  const g = (graphData && graphData.skills[name]) || null;
  return 5.5 + Math.sqrt((g && g.concept) || 1) * 1.15;
}

// The names the map is currently drawing. Every map read goes through it, so
// a rail filter narrows the plot, its edges, the lens counts and the inspector
// to the same set instead of narrowing the plot alone.
// Memoised on everything the set depends on: one paint asks for it from the
// edges, the mentions, the inspector and the proposals, and each rebuild walks
// every skill through linkStateOf(), which scans the runtime matrix.
// lastStateAt is the stamp loadState() writes, so a re-read invalidates it.
let mapNamesCache = { key: null, set: null };
function mapNames() {
  const key = JSON.stringify([
    lastStateAt,
    libArchived,
    statusFilter,
    linkFilter,
    syncFilter,
    axisFilters,
  ]);
  if (mapNamesCache.key !== key)
    mapNamesCache = { key, set: new Set(filteredSkills().map((s) => s.name)) };
  return mapNamesCache.set;
}
function mapEdges() {
  const vis = mapNames();
  return ((graphData && graphData.edges) || []).filter(
    (e) => vis.has(e.a) && vis.has(e.b),
  );
}
function mapMentionEdges() {
  const vis = mapNames();
  return ((graphData && graphData.mentions) || []).filter(
    (m) => vis.has(m.a) && vis.has(m.b),
  );
}

// Skills a lens or the search box puts in focus. null = no dimming.
function mapFocus(names) {
  const q = searchQ.trim().toLowerCase();
  if (q) return new Set(names.filter((n) => n.toLowerCase().includes(q)));
  if (!mapLens) return null;
  if (mapLens === "coupled")
    return new Set(mapEdges().flatMap((e) => [e.a, e.b]));
  if (mapLens === "unlinked") {
    const linked = new Set(mapEdges().flatMap((e) => [e.a, e.b]));
    return new Set(names.filter((n) => !linked.has(n)));
  }
  if (mapLens === "dupes")
    return new Set(
      names.filter((n) => (graphData.skills[n]?.dupes || []).length),
    );
  if (mapLens === "code")
    return new Set(names.filter((n) => graphData.skills[n]?.code));
  return null;
}

function mapCurve(a, b, k) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = Math.min(46, len * k);
  return `M${a.x} ${a.y} Q${mx - (dy / len) * off} ${my + (dx / len) * off} ${b.x} ${b.y}`;
}

function mapSvgHtml(width) {
  const groups = groupedSkills(filteredSkills());
  const { boxes, height } = mapLayout(groups, width);
  const pos = {};
  for (const b of boxes) Object.assign(pos, b.pos);
  const names = Object.keys(pos);
  const labels = mapLabels(names);
  const focus = mapFocus(names);
  const touches = (e) =>
    mapSel &&
    ((mapSel.t === "s" && (mapSel.k === e.a || mapSel.k === e.b)) ||
      (mapSel.t !== "s" && mapSel.a === e.a && mapSel.b === e.b));

  const fields = boxes
    .map(
      (b) =>
        `<g class="mgrp" style="${taxHueStyle(groupAxis, b.key)}"><rect class="mfield" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="12"/>` +
        (groupAxis === "none"
          ? ""
          : `<circle cx="${b.x + 14}" cy="${b.y + 17}" r="3.5" fill="var(--tint)"/><text class="mgt" x="${b.x + 24}" y="${b.y + 21}">${esc(b.label)}</text><text class="mgn" x="${b.x + b.w - 12}" y="${b.y + 21}" text-anchor="end">${b.items.length}</text>`) +
        `</g>`,
    )
    .join("");

  const mentions = mapMentions
    ? mapMentionEdges()
        .map((m, i) => {
          const a = pos[m.a];
          const b = pos[m.b];
          if (!a || !b) return "";
          return `<path class="mment${touches(m) ? " hot" : ""}" data-m="${i}" d="${mapCurve(a, b, 0.1)}" stroke-width="${Math.min(2.4, 0.8 + m.weight * 0.14)}"/>`;
        })
        .join("")
    : "";

  const edges = mapEdges()
    .map((e, i) => {
      const a = pos[e.a];
      const b = pos[e.b];
      if (!a || !b) return "";
      return `<path class="medge${touches(e) ? " hot" : ""}" data-e="${i}" d="${mapCurve(a, b, 0.13)}" stroke-width="${Math.min(3.4, 0.9 + e.weight * 0.28)}"/>`;
    })
    .join("");

  const selName = mapSel && mapSel.t === "s" ? mapSel.k : null;
  const order = selName
    ? names.filter((n) => n !== selName).concat(selName)
    : names;
  const nodes = order
    .map((n) => {
      const p = pos[n];
      const sk = (state.skills || []).find((s) => s.name === n);
      const r = mapRadius(n);
      const isSel = n === selName;
      const g = (graphData && graphData.skills[n]) || null;
      const dupe =
        g && g.dupes && g.dupes.length
          ? `<circle class="mdupe" cx="${p.x + r * 0.78}" cy="${p.y - r * 0.78}" r="2.6"/>`
          : "";
      const code =
        mapLens === "code" && g && g.code
          ? `<circle class="mcode" cx="${p.x - r * 0.78}" cy="${p.y - r * 0.78}" r="2.6"/>`
          : "";
      return (
        `<g class="mnode${isSel ? " sel" : ""}${focus && focus.has(n) ? " hit" : ""}" data-map-skill="${esc(n)}" style="${taxHueStyle(groupAxis, (sk && sk[groupAxis]) || "")}">` +
        `<circle class="mb" cx="${p.x}" cy="${p.y}" r="${r}"/>${dupe}${code}` +
        `<title>${esc(n)}</title>` +
        `<text class="mnl" x="${p.x}" y="${p.y + r + 12}">${esc(isSel ? n : labels[n])}</text></g>`
      );
    })
    .join("");

  return {
    html: `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Skill map">${fields}<g>${mentions}</g><g>${edges}</g>${nodes}</svg>`,
    focused: !!focus,
  };
}

function relChip(rel, n) {
  return `<span class="mrel">${esc(rel)}${n ? ` ${n}` : ""}</span>`;
}

// What the map cannot say in circles: which concepts tie two skills together,
// what a skill duplicates inside itself, how much code it carries.
function mapInspectorHtml() {
  // The strip above the canvas names the state and carries the action; this
  // column says what the state means, so the two are complementary rather
  // than the same sentence twice, 300px apart.
  if (graphState === "loading")
    return `<div class="mi-empty">The circles are placed from the library. What is still coming is what ties them: <code>graphify-out/graph.json</code>.</div>`;
  if (graphState === "error")
    return `<div class="mi-empty">The pipeline writes the graph; the dashboard only reads it. Nothing here is lost — the map is drawn from the library either way.</div>`;
  if (!graphData || !graphData.hasGraph)
    return `<div class="mi-empty"><b>Nothing extracted yet.</b><p>The circles come from the library, the lines from extraction. They appear once <code>graphify-out/graph.json</code> exists.</p></div>`;
  if (mapSel && mapSel.t === "s") return mapSkillCardHtml(mapSel.k);
  if (mapSel) return mapPairCardHtml(mapSel);
  return mapSummaryHtml();
}

// Proposte cross-famiglia che il modello ha confermato con la sua prova ma che
// il punteggio ha lasciato fuori. Il punteggio e' un'autovalutazione grossolana
// (si ammassa su 0.8/0.98/0.99): la frase la legge una persona in due secondi.
// A proposal between two skills the filter removed is not about the map on
// screen. Both ends have to be on it.
function weakCrossFor(forSkill) {
  const vis = mapNames();
  return (graphData?.weakCross || []).filter(
    (w) =>
      vis.has(w.a) &&
      vis.has(w.b) &&
      (!forSkill || w.a === forSkill || w.b === forSkill),
  );
}
// The evidence is a sentence, sometimes a paragraph. Two lines are enough to
// judge whether the pair is worth opening; the rest is one click away.
function weakBlockHtml(w, forSkill) {
  const other = forSkill ? (w.a === forSkill ? w.b : w.a) : `${w.a} → ${w.b}`;
  return (
    `<div class="mi-weak"><div class="mi-weak-top">` +
    `<span class="mrel">${esc(w.relation)}</span>` +
    `<span class="nm">${esc(other)}</span>` +
    `<span class="w">${w.score.toFixed(2)}</span></div>` +
    (w.evidence
      ? `<button class="mi-weak-ev clamp" type="button" data-expand="1"><span>${esc(w.evidence)}</span></button>`
      : "") +
    `</div>`
  );
}
const WEAK_NOTE = `<p class="mi-note">Confermate dall'estrazione con la loro prova, sotto la soglia di punteggio del vault. Restano nel layer: la prossima passata le riconferma o le lascia cadere.</p>`;
function weakCrossHtml(forSkill) {
  const weak = weakCrossFor(forSkill);
  if (!weak.length) return "";
  return (
    `<div class="mi-sec">Proposte non promosse (${weak.length})</div>` +
    weak.map((w) => weakBlockHtml(w, forSkill)).join("") +
    WEAK_NOTE
  );
}
// Eighty-one proposals, each with its own paragraph of evidence, do not fit a
// 320px rail at any page size: that column is forty-five characters of prose,
// and paging it only spreads the same illegibility over ten screens. They are
// homogeneous records — pair, relation, score, evidence — so they take the
// shape this app already uses for dense lists and the width the content area
// already has. The list stands in for the map while it is open; with no map
// there is nothing to inspect, so the inspector's column goes to it too.
function weakLedgerHtml() {
  const weak = weakCrossFor(null);
  // One section per relation type, biggest first, strongest score first inside.
  // The type is the axis you actually scan by: "what does the extractor think
  // hands off to what" is a different question from "what duplicates what".
  const byRel = new Map();
  for (const w of weak) {
    if (!byRel.has(w.relation)) byRel.set(w.relation, []);
    byRel.get(w.relation).push(w);
  }
  const sections = [...byRel.entries()]
    .sort((x, y) => y[1].length - x[1].length)
    .map(([rel, items]) => {
      const rows = items
        .sort((a, b) => b.score - a.score)
        .map(
          (w) =>
            `<tr data-prop="1"><td class="pw-pair">` +
            `<button class="pw-sk" data-skillref="${esc(w.a)}" type="button">${esc(w.a)}</button>` +
            `<span class="pw-arr">→</span>` +
            `<button class="pw-sk" data-skillref="${esc(w.b)}" type="button">${esc(w.b)}</button>` +
            `</td><td class="pw-ev"><span>${esc(w.evidence || "")}</span></td>` +
            `<td class="pw-sc">${w.score.toFixed(2)}</td></tr>`,
        )
        .join("");
      return (
        `<tbody class="pw-grp"><tr class="pw-sec"><td colspan="3">` +
        `<span class="pw-sechead"><span class="catdot"></span><h3>${esc(rel)}</h3>` +
        `<span class="n">${items.length}</span></span></td></tr>${rows}</tbody>`
      );
    })
    .join("");
  return (
    `<div class="propsview" id="propsledger">` +
    `<button class="mi-back" id="props-back" type="button">‹ Map</button>` +
    `<div class="pw-head"><h2>Proposte non promosse</h2>` +
    `<span class="cnt">${weak.length} pair${weak.length === 1 ? "" : "s"} · ${byRel.size} relation type${byRel.size === 1 ? "" : "s"}</span>` +
    `<span class="why">confermate dall'estrazione con la loro prova, sotto la soglia di punteggio del vault</span></div>` +
    (weak.length
      ? `<div class="tscroll"><table class="propsw">${sections}</table></div>`
      : `<div class="empty">Nessuna proposta per le skill che i filtri lasciano sulla mappa.</div>`) +
    `</div>`
  );
}

function mapSummaryHtml() {
  const m = graphData.meta;
  const names = filteredSkills().map((s) => s.name);
  const linked = new Set(mapEdges().flatMap((e) => [e.a, e.b]));
  const famSize = {};
  for (const n of names) famSize[famOf(n)] = (famSize[famOf(n)] || 0) + 1;
  const isolated = names.filter((n) => !linked.has(n) && famSize[famOf(n)] > 1);
  const dupes = names.filter(
    (n) => (graphData.skills[n]?.dupes || []).length,
  ).length;
  const heavy = mapEdges().filter((e) => e.weight >= 5).length;
  // Every finding counts what is on the canvas, filter included. The three
  // that used to read straight off meta counted the whole vault, so under a
  // filter the panel stated a finding about skills it was not drawing.
  const crossMentions = mapMentionEdges().filter(
    (x) => famOf(x.a) !== famOf(x.b),
  ).length;
  const carryingCode = names.filter((n) => graphData.skills[n]?.code).length;
  const vis = mapNames();
  const weak = (graphData.weakCross || []).filter(
    (w) => vis.has(w.a) && vis.has(w.b),
  );
  const row = (lens, label, n) =>
    `<button class="mi-row" data-lens="${lens}"><span class="nm">${label}</span><span class="w">${n}</span></button>`;
  const code = m.code;
  return (
    `<div class="mi-head"><h3>Vault graph</h3><div class="mi-stamp">${m.builtAtCommit ? `built at <code>${esc(m.builtAtCommit.slice(0, 7))}</code>` : "build commit unknown"}</div></div>` +
    // With a rail filter on, the findings above count what is drawn and the
    // coverage below counts the vault the graph was built from. Say which is
    // which rather than letting two scopes sit unlabelled in one panel.
    (anyFilterOn()
      ? `<div class="mi-scope">Findings cover the <b>${names.length} of ${(state.skills || []).length}</b> skills the filter leaves on the map. Coverage below is the whole vault.</div>`
      : "") +
    `<div class="mi-sec">Findings</div>` +
    row("dupes", "Skills stating the same rule twice", dupes) +
    row("coupled", "Pairs coupled hard enough to merge", heavy) +
    row("mentions", "Cross-family links extraction cannot see", crossMentions) +
    row("unlinked", "Skills nothing points at, family aside", isolated.length) +
    (code ? row("code", "Skills carrying code", carryingCode) : "") +
    (weak.length
      ? `<button class="mi-row has-panel" data-weak="1"><span class="nm">Cross-family proposals not promoted</span><span class="w">${weak.length}</span><span class="chev">›</span></button>`
      : "") +
    `<div class="mi-sec">Coverage</div>` +
    `<dl class="mi-kv">` +
    `<dt>Skills indexed</dt><dd>${m.skillsIndexed} of ${m.skillsOnDisk}</dd>` +
    `<dt>Concepts</dt><dd>${m.nodes.toLocaleString("en-US")}</dd>` +
    `<dt>Relations</dt><dd>${m.links.toLocaleString("en-US")}</dd>` +
    // Coverage describes the vault the graph was built from, so its
    // denominator is every extracted relation, not the ones a filter leaves.
    `<dt>Cross-family relations</dt><dd>${m.crossFamilyEdges} of ${(graphData.edges || []).length}</dd>` +
    (code
      ? `<dt>Code graph</dt><dd>${code.nodes.toLocaleString("en-US")} nodes${code.commitsBehind ? `, ${code.commitsBehind} behind` : ""}</dd>`
      : "") +
    `</dl>` +
    `<p class="mi-note">Extraction runs one family at a time, and ${m.singletonFamilies} of the ${m.families} families hold a single skill. Two skills in different families are never in the same prompt, so a relation between them cannot be extracted: read isolation against the family it sits in.</p>` +
    (code
      ? `<p class="mi-note">Code lives in its own graph, joined here on the skill folder. It can say how much code a skill carries, never which concept that code implements.</p>`
      : "")
  );
}

function mapSkillCardHtml(name) {
  const sk = (state.skills || []).find((s) => s.name === name);
  const g = graphData.skills[name] || {
    concept: 0,
    document: 0,
    rationale: 0,
    dupes: [],
  };
  const rel = mapEdges()
    .filter((e) => e.a === name || e.b === name)
    .sort((a, b) => b.weight - a.weight);
  const ment = mapMentionEdges()
    .filter((m) => m.a === name || m.b === name)
    .sort((a, b) => b.weight - a.weight);
  const chips = axisList()
    .map((a) =>
      sk && sk[a.id]
        ? `<span class="mchip" style="${taxHueStyle(a.id, sk[a.id])}"><span class="d"></span>${esc(humanTax(sk[a.id]))}</span>`
        : "",
    )
    .join("");
  const relRow = (e) => {
    const other = e.a === name ? e.b : e.a;
    const top = Object.entries(e.relations).sort((x, y) => y[1] - x[1])[0][0];
    return `<button class="mi-row" data-pair="${esc(e.a)}|${esc(e.b)}">${relChip(top)}<span class="nm">${esc(other)}</span><span class="w">${e.weight}</span></button>`;
  };
  const mentRow = (m) => {
    const other = m.a === name ? m.b : m.a;
    return `<button class="mi-row" data-ment="${esc(m.a)}|${esc(m.b)}">${relChip(m.crossFamily ? "cross-family" : "mention")}<span class="nm">${esc(other)}</span><span class="w">${m.weight}</span></button>`;
  };
  return (
    `<div class="mi-head"><h3>${esc(sk ? sk.title : name)}</h3><div class="mi-stamp"><code>${esc(name)}</code></div></div>` +
    (chips ? `<div class="mi-chips">${chips}</div>` : "") +
    (sk && sk.description
      ? `<p class="mi-desc">${esc(sk.description)}</p>`
      : "") +
    `<div class="mi-sec">Knowledge</div>` +
    `<dl class="mi-kv"><dt>Concepts</dt><dd>${g.concept}</dd><dt>Documents</dt><dd>${g.document}</dd><dt>Rationale</dt><dd>${g.rationale}</dd></dl>` +
    `<div class="mi-sec">Relations${rel.length ? ` (${rel.length})` : ""}</div>` +
    (rel.length
      ? rel.map(relRow).join("")
      : `<p class="mi-note">No other skill points at this one, and it points at none.${famOf(name) && (state.skills || []).filter((s) => famOf(s.name) === famOf(name)).length === 1 ? " It is alone in its family, so extraction never had a second skill to relate it to." : " Either it is genuinely standalone, or its handoffs are implied in prose the extractor could not resolve."}</p>`) +
    (ment.length
      ? `<div class="mi-sec">Mentions (${ment.length})</div>` +
        ment.map(mentRow).join("") +
        `<p class="mi-note">Named in the markdown, never extracted as a relation.</p>`
      : "") +
    (g.dupes && g.dupes.length
      ? `<div class="mi-sec">Inside this skill</div>` +
        `<div class="mi-flag"><b>${g.dupes.length} duplicate concept pair${g.dupes.length === 1 ? "" : "s"}.</b> The same rule stated twice in different words.</div>` +
        g.dupes
          .map(
            (p) =>
              `<div class="mi-pair">${esc(p[0])} <em>duplicates</em> ${esc(p[1])}</div>`,
          )
          .join("")
      : "") +
    (g.code
      ? `<div class="mi-sec">Code</div><dl class="mi-kv">` +
        g.code.files
          .map((f) => `<dt><code>${esc(f.path)}</code></dt><dd>${f.nodes}</dd>`)
          .join("") +
        `</dl><p class="mi-note">Node counts from the code graph, joined on the skill folder.</p>`
      : "") +
    weakCrossHtml(name) +
    `<div class="mi-btns"><button class="mi-btn p" data-open="${esc(name)}">Open skill</button></div>`
  );
}

function mapPairCardHtml(sel) {
  const isMention = sel.t === "m";
  const e = (isMention ? mapMentionEdges() : mapEdges()).find(
    (x) => x.a === sel.a && x.b === sel.b,
  );
  if (!e) return mapSummaryHtml();
  const head =
    `<div class="mi-head"><h3>${esc(e.a)} <span class="ar">↔</span> ${esc(e.b)}</h3>` +
    `<div class="mi-stamp">${e.weight} ${isMention ? `mention${e.weight === 1 ? "" : "s"} in markdown` : `relation${e.weight === 1 ? "" : "s"}`}</div></div>`;
  if (isMention)
    return (
      head +
      `<div class="mi-chips">${relChip(e.crossFamily ? "cross-family" : "same family")}</div>` +
      `<div class="mi-flag">${
        e.crossFamily
          ? `<b>Extraction never saw these two together.</b> <code>${esc(famOf(e.a))}</code> and <code>${esc(famOf(e.b))}</code> are separate runs, so no relation between them can be produced. This is a name match in the text, not an extracted relation.`
          : `Same family, named in the text but not extracted as a relation. Either the mention is incidental, or the extractor missed it.`
      }</div>` +
      `<div class="mi-btns"><button class="mi-btn" data-open="${esc(e.a)}">Open ${esc(e.a)}</button><button class="mi-btn" data-open="${esc(e.b)}">Open ${esc(e.b)}</button></div>`
    );
  return (
    head +
    `<div class="mi-chips">${Object.entries(e.relations)
      .sort((x, y) => y[1] - x[1])
      .map(([r, n]) => relChip(r, n))
      .join("")}</div>` +
    `<div class="mi-sec">What links them</div>` +
    e.samples
      .map(
        (s) =>
          `<div class="mi-pair">${esc(s.source)} <em>${esc(s.rel)}</em> ${esc(s.target)}</div>`,
      )
      .join("") +
    (e.weight >= 5
      ? `<div class="mi-flag"><b>Heavy coupling.</b> ${e.weight} relations across two skills is either a shared reference to extract, or a split that should be one skill.</div>`
      : "") +
    `<div class="mi-btns"><button class="mi-btn" data-open="${esc(e.a)}">Open ${esc(e.a)}</button><button class="mi-btn" data-open="${esc(e.b)}">Open ${esc(e.b)}</button></div>`
  );
}

// A lens answers a question ("what does nothing point at?"), so picking one
// clears the selection: the two compete for the same attention.
function setMapLens(id) {
  if (id === "mentions") {
    mapMentions = true;
    mapLens = null;
  } else {
    mapLens = mapLens === id ? null : id;
  }
  mapSel = null;
  // A lens is a way of reading the canvas. Picking one while a finding's list
  // stands in for it is a request for the canvas back.
  if (mapPanel) {
    mapPanel = null;
    return repaintLibrary();
  }
  const rail = $("#librail");
  if (rail) rail.innerHTML = renderRailHtml();
  paintMap();
}

// Rail sections the map adds: what kind of relation is drawn, and the lenses
// that answer a question rather than filter a field.
function mapRailHtml() {
  if (libView !== "map" || libArchived) return "";
  // Relations and the lenses over them are about edges. With no graph there are
  // none, and a lens reading "Unlinked 46" would be counting the absence of a
  // file rather than a property of the vault.
  if (!graphData || !graphData.hasGraph) return "";
  const names = filteredSkills().map((s) => s.name);
  const linked = new Set(mapEdges().flatMap((e) => [e.a, e.b]));
  const famSize = {};
  for (const n of names) famSize[famOf(n)] = (famSize[famOf(n)] || 0) + 1;
  const counts = {
    unlinked: names.filter((n) => !linked.has(n) && famSize[famOf(n)] > 1)
      .length,
    coupled: mapEdges().length,
    dupes: names.filter((n) => (graphData?.skills[n]?.dupes || []).length)
      .length,
    code: names.filter((n) => graphData?.skills[n]?.code).length,
  };
  const lens = (id, label) =>
    `<button class="ritem lens${mapLens === id ? " on" : ""}" data-lens="${id}" type="button"><span class="d"></span>${label}<span class="n">${counts[id]}</span></button>`;
  return (
    `<div class="rl">Relations</div>` +
    `<button class="ritem on" type="button" disabled><span class="ln"></span>Extracted<span class="n">${mapEdges().length}</span></button>` +
    `<button class="ritem${mapMentions ? " on" : ""}" id="mentoggle" type="button"><span class="ln dash"></span>Mentions<span class="n">${mapMentionEdges().length}</span></button>` +
    `<div class="rl">Lenses</div>` +
    lens("unlinked", "Unlinked") +
    lens("coupled", "Coupled pairs") +
    lens("dupes", "Duplicates inside") +
    (counts.code ? lens("code", "Carrying code") : "")
  );
}

// The map is two things arriving separately: the skills, which the library
// already holds, and the relations between them, which come from the graph.
// So a missing graph is not a missing map — the fields, the circles and the
// labels draw from /api/state alone, and only the edges wait. What used to be
// a 60ch box standing in for the whole canvas is now a line above it: the
// state names itself where the eye already is, and the map underneath is real.
function mapStripHtml() {
  const line = (cls, text, action) =>
    `<div class="mapstrip-in ${cls}"><span class="d" aria-hidden="true"></span>` +
    `<span class="t">${text}</span>` +
    (action ? `<span class="a">${action}</span>` : "") +
    `</div>`;
  // Nothing while the read is in flight. It lasts a few hundred milliseconds:
  // a sentence that cannot be finished before it disappears is a flash, not
  // information. The faded nodes say the map is not final yet, and the top
  // progress bar says something is being read — that is the whole message.
  if (graphState === "loading") return "";
  if (graphState === "error")
    return line(
      "quiet",
      "<b>The graph could not be read</b> — a build in flight leaves the file half written",
      `<button class="btn" id="mapretry" type="button">Try again</button>`,
    );
  if (!graphData || !graphData.hasGraph)
    return line(
      "quiet",
      "<b>No relations extracted yet</b> — the map shows the skills, not what ties them",
      `<button class="btn" id="mapretry" type="button">Check again</button>`,
    );
  if (!filteredSkills().length)
    return line(
      "quiet",
      "<b>No skill matches these filters</b> — the map draws the same set the rail filters",
      `<button class="btn" id="mapclear" type="button">Clear filters</button>`,
    );
  return "";
}

// Paint the plot into its container. Called after the library renders and on
// resize: the layout needs a measured width, which markup alone cannot give.
function paintMap() {
  const plot = $("#mapplot");
  if (!plot) return;
  // A selection that the filter just removed would keep the inspector on a
  // skill no longer on the canvas.
  if (mapSel) {
    const vis = mapNames();
    const gone =
      mapSel.t === "s"
        ? !vis.has(mapSel.k)
        : !vis.has(mapSel.a) || !vis.has(mapSel.b);
    if (gone) mapSel = null;
  }
  const strip = $("#mapstrip");
  if (strip) strip.innerHTML = mapStripHtml();
  // Only an empty set leaves nothing to draw. Without a graph the fields and
  // the circles are still real — mapEdges() simply returns none — so the map
  // draws either way and says so above itself.
  const hasGraph = !!(graphData && graphData.hasGraph);
  if (!filteredSkills().length) {
    plot.innerHTML = "";
    plot.classList.remove("focused", "hassel", "skeleton");
    plot.removeAttribute("role");
    plot.removeAttribute("aria-label");
  } else {
    const width = Math.max(520, plot.clientWidth - 4);
    const { html, focused } = mapSvgHtml(width);
    plot.innerHTML = html;
    plot.classList.toggle("focused", focused);
    plot.classList.toggle("hassel", !!mapSel);
    plot.classList.toggle("skeleton", !hasGraph);
    // The plot is a mouse-only surface: its circles are SVG shapes, not
    // controls. Naming it as one image at least tells a screen-reader user what
    // they are skipping and that the same data is in the table.
    const groups = groupedSkills(filteredSkills());
    const n = groups.reduce((sum, g) => sum + g.items.length, 0);
    // Ungrouped, groupKeyOf() returns "" for every skill and they all land in
    // one bucket: announcing "in 1 group" would describe the fallback, not the
    // map on screen.
    const where =
      groupAxis === "none"
        ? ""
        : ` in ${groups.length} ${groupAxis} group${groups.length === 1 ? "" : "s"}`;
    plot.setAttribute("role", "img");
    plot.setAttribute(
      "aria-label",
      hasGraph
        ? `Map of ${n} skill${n === 1 ? "" : "s"}${where}, with their extracted relations. The same skills are listed in the table view.`
        : `Map of ${n} skill${n === 1 ? "" : "s"}${where}. The relations between them are not drawn yet. The same skills are listed in the table view.`,
    );
  }
  const insp = $("#mapinsp");
  if (insp) {
    insp.innerHTML = mapInspectorHtml();
    fitInspector(insp);
  }
}

// The ceiling that keeps the pinned inspector pinned. A sticky box comes loose
// as soon as it is taller than the room between the top it pins to and the
// bottom of its containing block, and the map's block ends before the scroll
// does — the column's own bottom padding sits under it. Bound the panel to
// that room and the difference can never go positive, so it holds all the way
// down; the heading is pinned again inside it (see ui.css) so the panel's own
// scrolling cannot carry away what the column is about.
//
// Measured rather than written as a viewport formula: the scrollport sits
// under a header and a source band whose heights are not this file's to
// assume, and an error of a few pixels here is a slide of a few pixels there.
function fitInspector(insp) {
  const port = insp.closest(".libmain");
  if (!port) return;
  const cs = getComputedStyle(port);
  const room =
    port.clientHeight -
    (parseFloat(cs.paddingTop) || 0) -
    (parseFloat(cs.paddingBottom) || 0);
  insp.style.setProperty("--insp-max", `${Math.max(240, Math.round(room))}px`);
}

// The server answers with hasGraph:false when graph.json is missing OR when it
// was read half written mid build — degrading instead of taking the dashboard
// down. Caching that answer for the session is what made a map stay empty
// until the page was reloaded, so an unusable answer is retried. The cooldown
// is what keeps that from turning into a fetch per rail click: the library
// re-renders (and re-mounts the map) on every filter.
const GRAPH_RETRY_MS = 15000;
let graphAt = 0; // when the last /api/graph attempt landed
async function mountMap(force = false) {
  paintMap();
  if (graphState === "loading") return;
  if (graphData && graphData.hasGraph && !force) return;
  if (!force && graphAt && Date.now() - graphAt < GRAPH_RETRY_MS) return;
  graphState = "loading";
  paintMap();
  // Say the read is happening with the same top progress bar every other async
  // view uses, on top of the state the canvas now carries.
  navStart();
  const r = await api("/api/graph");
  navStop();
  graphAt = Date.now();
  graphState = r.ok ? "idle" : "error";
  graphData = r.ok ? r.data : null;
  if (libView !== "map") return;
  const rail = $("#librail");
  if (rail) rail.innerHTML = renderRailHtml();
  paintMap();
}
// The pipeline rebuilds the graph while the page is open, and the freshness
// poll is the only thing that hears about it. Drop the cached read once per
// build commit, so the map follows a rebuild without a reload.
let graphSeenCommit = null;
function invalidateGraphIfRebuilt() {
  const built = graphData && graphData.meta && graphData.meta.builtAtCommit;
  const fresh = freshData && freshData.freshThroughCommit;
  if (!built || !fresh || built === fresh) return;
  if (graphSeenCommit === fresh) return;
  graphSeenCommit = fresh;
  graphData = null;
  graphAt = 0;
  if (libView === "map" && $("#mapplot")) mountMap();
}

// Per-skill link summary from the runtime matrix, in the same words as
// the Status legend: linked / partial / not linked / conflict.
function linkStateOf(s) {
  const states = (state.matrix || [])
    .filter((m) => m.skill === s.name)
    // An overridden pair is not a measurement: the runtime owns that name
    // (external) or is meant not to have it (disabled). Left in, it would hold
    // a fully projected skill at "partial" forever — the exact report the
    // override was written to stop.
    .filter((m) => m.state !== "external" && m.state !== "disabled")
    .map((m) => m.state);
  // "served" (in-place) covers a skill just like a symlink does.
  const covered = (x) => x === "linked" || x === "served";
  // Non-active skills (suspended/deprecated/draft/idea) are dropped from
  // the matrix server-side, so they arrive with zero rows. Their coverage
  // is still deterministic — same rule renderStatus/renderDetail apply: an
  // in-place consumer serves them from the vault, a symlink consumer does
  // not. Synthesize those states so the badge/filter/rail agree with the
  // detail pane instead of a blanket "not linked". Guarded on the empty
  // case so the active-skill path (always ≥1 row) is untouched.
  if (!states.length) {
    for (const cv of Object.values(state.consumers || {})) {
      const isInplace = cv && typeof cv === "object" && cv.mode === "in-place";
      states.push(isInplace ? "served" : "missing");
    }
  }
  if (states.length && states.every(covered)) return "linked";
  if (states.some((x) => x === "foreign" || x === "broken")) return "conflict";
  if (states.some(covered)) return "partial";
  return "not linked";
}
const LINK_ORDER = ["linked", "partial", "not linked", "conflict"];
const LINK_CLS = {
  linked: "ok",
  partial: "warn",
  "not linked": "off",
  conflict: "bad",
};
const LINK_DOT = {
  linked: "var(--ok)",
  partial: "var(--warn)",
  "not linked": "var(--dim)",
  conflict: "var(--err)",
};
const SYNC_ORDER = ["clean", "dirty", "ahead", "behind"];
const SYNC_LABEL = {
  clean: "synced",
  dirty: "to commit",
  ahead: "to push",
  behind: "to pull",
};
const SYNC_DOT = {
  clean: "var(--ok)",
  dirty: "var(--warn)",
  ahead: "var(--accent)",
  behind: "var(--accent)",
};
function linkCell(s) {
  const v = linkStateOf(s);
  const title =
    v === "conflict"
      ? ' title="Something that is not the vault\'s link owns the runtime path"'
      : v === "partial"
        ? ' title="Linked into some runtimes, not all"'
        : "";
  return `<span class="badge ${LINK_CLS[v]}"${title}>${esc(v)}</span>`;
}
// Per-skill git state: what this skill still needs before it is aligned
// with the remote (from the last fetch; the on-open check refreshes it).
function syncCell(v) {
  if (v === "dirty")
    return `<span class="badge warn" title="Uncommitted edits under this skill">to commit</span>`;
  if (v === "ahead")
    return `<span class="badge acc" title="In commits not pushed yet">to push</span>`;
  if (v === "behind")
    return `<span class="badge acc" title="In remote commits not pulled yet">to pull</span>`;
  return `<span class="badge ok" title="Committed and aligned with the remote">synced</span>`;
}
// The ledger is table-layout:fixed (so a column cannot resize under you while
// filtering hides rows), which also means the browser will not size a column to
// its content — we measure it. Labels come from the whole vault rather than the
// current filter, so the widths stay put as you filter.
//
// The word each sync state renders as, so a column can be measured against what
// it will actually show.
const SYNC_WORD = {
  clean: "synced",
  dirty: "to commit",
  ahead: "to push",
  behind: "to pull",
};
// A pill column: an 11.5px label inside a badge, inside a cell. The +6 is
// slack: canvas measureText resolves the font stack on its own and lands a few
// px under what Figtree actually renders, which is enough to ellipsize a label
// the column was sized to hold.
const PILL_COL = { size: 11.5, weight: 600, pad: 18 + 16 + 6 };
// A plain-text column (Updated): no pill, wider cell padding.
const TEXT_COL = { size: 12, weight: 400, pad: 20 + 6 };
const textWidth = (() => {
  let cx = null;
  return (text, font, tracking = 0) => {
    if (!cx) cx = document.createElement("canvas").getContext("2d");
    cx.font = font;
    return cx.measureText(text).width + tracking * text.length;
  };
})();
/** The distinct labels a column will actually show, taken from the whole vault
 *  rather than the current filter so a column does not resize while you filter.
 *  Every column follows this same rule — sizing one against its full vocabulary
 *  and another against what is present is what left Status wider than Area for
 *  no visible reason. */
// Sized against the set the table is about to render, not the active library:
// the archive holds statuses (suspended, deprecated) the live vault may not,
// and a column measured on the wrong set clips the badge it is sizing for.
function presentLabels(pick) {
  return [...new Set(libSkills().map(pick).filter(Boolean))];
}
/** Width in px for a column showing `labels`, never narrower than its own
 *  heading (10.5px bold uppercase, 0.06em tracking, 10px cell sides). */
function colWidth(labels, headLabel, { size, weight, pad }) {
  const fam = getComputedStyle(document.body).fontFamily;
  const body = labels.length
    ? Math.max(...labels.map((l) => textWidth(l, `${weight} ${size}px ${fam}`)))
    : 0;
  const head = textWidth(
    String(headLabel).toUpperCase(),
    `700 10.5px ${fam}`,
    10.5 * 0.06,
  );
  return Math.ceil(Math.max(body + pad, head + 20));
}
// Ledger (list view): one row per skill, a tbody per group so filtering
// can hide whole groups; column headers write sortMode/sortDir, which
// groupedSkills() consumes — table order and arrow-nav stay in step.
function renderTableHtml() {
  const orth = orthAxesOf();
  const arrow = (c) =>
    sortMode === c ? `<span class="arr">${sortDir > 0 ? "▲" : "▼"}</span>` : "";
  // One real column per axis, each sized to what it actually holds. Description
  // carries no width, so it absorbs whatever the sized columns leave.
  const axisCells = (id) =>
    colWidth(
      [
        ...new Set(
          libSkills()
            .map((s) => s[id])
            .filter(Boolean),
        ),
      ].map(humanTax),
      axisLabel(id),
      PILL_COL,
    );
  const head =
    // The archive drops the two runtime columns, so the name takes back the
    // width they were holding instead of leaving it all to the description.
    `<thead><tr><th class="selcol"></th><th data-sort="name" style="width:${libArchived ? 24 : 16}%">Skill ${arrow("name")}</th><th>Description</th>` +
    orth
      .map(
        (a) => `<th style="width:${axisCells(a)}px">${esc(axisLabel(a))}</th>`,
      )
      .join("") +
    `<th style="width:${colWidth(
      presentLabels((s) => statusLabel(s.status || "active").toLowerCase()),
      "Status",
      PILL_COL,
    )}px">Status</th>` +
    // Where a skill is served, and whether the vault has it committed. Neither
    // applies to an archived skill: it is served nowhere, and the archive rows
    // used to state a "partial / synced" nothing had produced.
    (libArchived
      ? ""
      : `<th style="width:${colWidth(presentLabels(linkStateOf), "Links", PILL_COL)}px">Links</th>` +
        `<th style="width:${colWidth(
          presentLabels((s) => SYNC_WORD[s.sync || "clean"]),
          "Sync",
          PILL_COL,
        )}px">Sync</th>`) +
    `<th data-sort="updated" style="width:${colWidth(["Yesterday", "Sep 30"], `${libArchived ? "Archived" : "Updated"} ▲`, TEXT_COL)}px">${libArchived ? "Archived" : "Updated"} ${arrow("updated")}</th></tr></thead>`;
  const bodies = groupedSkills()
    .map((g) => {
      const secRow =
        groupAxis === "none"
          ? ""
          : `<tr class="lsec"><td colspan="${(libArchived ? 5 : 7) + orth.length}"><span class="lsechead" style="${taxHueStyle(groupAxis, g.key)}"><span class="catdot"></span><h2>${esc(g.label)}</h2><span class="n">${g.items.length} skill${g.items.length === 1 ? "" : "s"}</span></span></td></tr>`;
      const rows = g.items
        .map((s) => {
          const hay = skillHay(s);
          const cells = orth
            .map((a) =>
              s[a]
                ? `<td class="ltax">${taxChip(a, s[a])}</td>`
                : `<td class="ltax lnone">–</td>`,
            )
            .join("");
          return `<tr class="${libSel.has(s.name) ? "sel" : ""}" data-skill="${esc(s.name)}" data-hay="${esc(hay)}" ${axisDataAttrs(s)} data-status="${esc(s.status || "active")}" ${libArchived ? "" : `data-link="${esc(linkStateOf(s))}" data-sync="${esc(s.sync || "clean")}"`}><td class="selcol"><span class="selbox" aria-hidden="true"></span></td><td><span class="lname">${skillTile(s)}<span class="lnt">${esc(s.title)}</span></span></td><td class="ldesc">${esc(s.description || "")}</td>${cells}<td>${statusBadge(s.status, true)}</td>${libArchived ? "" : `<td>${linkCell(s)}</td><td>${syncCell(s.sync)}</td>`}<td class="lwhen">${esc(fmtWhen(s.modified))}</td></tr>`;
        })
        .join("");
      return `<tbody class="lgroup">${secRow}${rows}</tbody>`;
    })
    .join("");
  return `<div class="tscroll"><table class="ledger" id="ledger">${head}${bodies}</table></div>`;
}
// On open, a dry sync check proposes push/pull so the vault stays
// aligned with the remote (dismissable, once per session).
function syncBannerHtml() {
  if (
    syncBannerDismissed ||
    !sync ||
    !sync.versioned ||
    !sync.remote ||
    (!sync.ahead && !sync.behind && !sync.dirty)
  )
    return "";
  const parts = [];
  if (sync.dirty)
    parts.push(`${sync.dirty} unsaved change${sync.dirty === 1 ? "" : "s"}`);
  if (sync.ahead)
    parts.push(`${sync.ahead} commit${sync.ahead === 1 ? "" : "s"} to push`);
  if (sync.behind)
    parts.push(`${sync.behind} commit${sync.behind === 1 ? "" : "s"} to pull`);
  return `<div class="syncbanner"><span class="sbt"><b>Vault out of sync.</b> ${esc(parts.join(" · "))}.</span><span class="sba"><button class="btn primary" id="syncnow" type="button">Sync now</button><button class="btn" data-go="status" type="button">Review</button><button class="sbx" id="syncdismiss" type="button" aria-label="Dismiss">×</button></span></div>`;
}
// "A", "A and B", "A, B and C" — commas, single trailing "and".
function listJoin(a) {
  if (a.length <= 1) return a.join("");
  return a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
}
// Switching view mode, sorting, filtering or dismissing a banner all repaint
// the library in place. The view fade belongs to a real view change: re-arming
// it here dips the whole page to zero opacity and back, which reads as a flash.
function repaintLibrary() {
  app().classList.add("norefade");
  renderLibrary();
}

function renderLibrary() {
  const consumers = listJoin(Object.keys(state.consumers).map(rtName));
  const total = libSkills().length;
  // The set decides which controls exist at all: an axis the set does not
  // carry is not offered, here or in the rail, and neither is a status it does
  // not hold.
  normalizeGroupAxis();
  normalizeStatusFilter();
  // Archiving takes a skill out of extraction, so archived skills have no
  // nodes and no relations. The archive therefore does not offer the map at
  // all — a mode that can only render an explanation is a dead end, not a
  // mode. setLibArchived() steps off it on the way in and back onto it on the
  // way out.
  const canMap = !libArchived;
  let groupsHtml = "";
  if (libView === "map" && mapPanel === "weak") {
    // The finding's list stands in for the map, across the whole content area.
    groupsHtml = weakLedgerHtml();
  } else if (libView === "map") {
    // The plot needs a measured width, so the shell goes in now and paintMap
    // fills it once the element is in the document.
    groupsHtml = `<div class="maplayout"><div class="mapcol"><div class="mapstrip" id="mapstrip"></div><div class="mapplot" id="mapplot"></div></div><aside class="mapinsp" id="mapinsp"></aside></div>`;
  } else if (libView === "list") {
    groupsHtml = renderTableHtml();
  } else {
    for (const g of groupedSkills()) {
      const cards = g.items.map(libCard).join("");
      if (groupAxis === "none") {
        groupsHtml += `<section class="catsec"><div class="grid">${cards}</div></section>`;
      } else {
        groupsHtml += `<section class="catsec" style="${taxHueStyle(groupAxis, g.key)}"><div class="cat"><span class="catdot"></span><h2>${esc(g.label)}</h2><span class="n">${g.items.length} skill${g.items.length === 1 ? "" : "s"}</span></div><div class="grid">${cards}</div></section>`;
      }
    }
  }
  const archived = state.archived || [];
  const GRID_IC =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>';
  const MAP_IC =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4" cy="4.5" r="2"/><circle cx="12" cy="6.5" r="2"/><circle cx="7" cy="12" r="2"/><path d="M5.8 5.2 10.2 6M11 8.4 8.3 10.4M5.4 6.3 6.4 10"/></svg>';
  const LIST_IC =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.5" cy="4" r="0.8" fill="currentColor" stroke="none"/><circle cx="2.5" cy="8" r="0.8" fill="currentColor" stroke="none"/><circle cx="2.5" cy="12" r="0.8" fill="currentColor" stroke="none"/></svg>';
  // The source switcher rides above every My-skills view, the archive
  // included: it is how you leave for another source from here.
  const chips = sourceChipsHtml();
  setFixed(true);
  // Crossing between the two sets closes the view: the archive is what comes
  // after the library, so the way across sits after the rows. The one place it
  // cannot is the map, which is two screens tall — a link at the foot of it is
  // a link nobody will scroll to. There the `a` shortcut is the way across.
  const cross =
    libView === "map"
      ? ""
      : libArchived
        ? `<button class="archivedlink" id="back-active">← Active skills</button>`
        : archived.length
          ? `<button class="archivedlink" data-go="archived">Archived skills (${archived.length}) →</button>`
          : "";
  app().innerHTML = `<div class="liblayout${chips ? " hasband" : ""}">
          ${chips}
          <aside class="librail" id="librail">${renderRailHtml()}</aside>
          <main class="libmain">
            <div class="libhead"><div><h1 class="view">${libArchived ? "Archived skills" : "Your skill library"}</h1><p class="sub">${libArchived ? `${total} skill${total === 1 ? "" : "s"} retired from every runtime. Open one to read it, then Restore to bring it back.` : `${total} skill${total === 1 ? "" : "s"}${consumers ? `, shared with ${esc(consumers)}` : ""}. <span id="syncnote">${syncNoteHtml()}</span>`}</p></div>${libArchived ? "" : '<button class="new" data-go="new">+ New skill</button>'}</div>
            ${syncBannerHtml()}
            <div class="libbar">
              <div class="search">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5.2" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3.4 3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                <input id="search" placeholder="Search your skills…" aria-label="Search your skills" value="${esc(searchQ)}" />
              </div>
              <div class="seg" id="viewtoggle"><button data-view="grid"${libView === "grid" ? ' class="on"' : ""} type="button" aria-label="Grid view">${GRID_IC}</button><button data-view="list"${libView === "list" ? ' class="on"' : ""} type="button" aria-label="List view">${LIST_IC}</button>${canMap ? `<button data-view="map"${libView === "map" ? ' class="on"' : ""} type="button" aria-label="Map view">${MAP_IC}</button>` : ""}</div>
            </div>
            <div id="groups">${groupsHtml}</div>
            <div id="noresult" class="empty" hidden></div>
            ${cross}
          </main>
        </div>`;
  $("#search").addEventListener("input", (e) => {
    searchQ = e.target.value;
    // The map has no DOM rows to hide: search re-paints it instead.
    if (libView === "map") paintMap();
    else filterLibrary();
  });
  if (libView === "map") mountMap();
  $("#back-active")?.addEventListener("click", () => {
    setLibArchived(false);
    go("skills");
  });
  if ($("#syncnow")) $("#syncnow").addEventListener("click", doSaveSync);
  if ($("#syncdismiss"))
    $("#syncdismiss").addEventListener("click", () => {
      syncBannerDismissed = true;
      repaintLibrary();
    });
  $("#librail").addEventListener("click", (e) => {
    const g = e.target.closest("#groupby button");
    if (g) {
      setGroupAxis(g.dataset.axis);
      repaintLibrary();
      return;
    }
    if (e.target.closest("#mentoggle")) {
      mapMentions = !mapMentions;
      // Same as a lens: it changes what the canvas draws, so it asks for the
      // canvas back.
      if (mapPanel) {
        mapPanel = null;
        repaintLibrary();
        return;
      }
      $("#librail").innerHTML = renderRailHtml();
      paintMap();
      return;
    }
    const lensBtn = e.target.closest("[data-lens]");
    if (lensBtn) {
      setMapLens(lensBtn.dataset.lens);
      return;
    }
    const b = e.target.closest(".ritem");
    if (!b) return;
    const v = b.dataset.v;
    const kind = b.dataset.kind;
    if (axisList().some((a) => a.id === kind))
      axisFilters[kind] = axisFilters[kind] === v ? null : v;
    else if (kind === "link") linkFilter = linkFilter === v ? null : v;
    else if (kind === "sync") syncFilter = syncFilter === v ? null : v;
    else setStatusFilter(statusFilter === v ? null : v);
    // A filter narrows whatever the view is showing — the map, the rows, or a
    // finding's list, which is drawn from the same filtered set and so has to
    // be rebuilt rather than repainted.
    if (mapPanel) return void repaintLibrary();
    $("#librail").innerHTML = renderRailHtml();
    if (libView === "map") paintMap();
    else filterLibrary();
  });

  // The plot is laid out against a measured width, so it has to be redrawn
  // when that width changes.
  if (libView === "map") {
    let resizeTimer = null;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (libView === "map" && $("#mapplot")) paintMap();
      }, 120);
    };
    window.removeEventListener("resize", window.__loomMapResize || (() => {}));
    window.__loomMapResize = onResize;
    window.addEventListener("resize", onResize);
  }

  // The proposals stand in for the map, so they get their own root: a back to
  // the map, a skill name that takes you there with that skill picked, and a
  // row that opens its own evidence in place.
  const propsRoot = $("#propsledger");
  if (propsRoot)
    propsRoot.addEventListener("click", (e) => {
      if (e.target.closest("#props-back")) {
        mapPanel = null;
        return repaintLibrary();
      }
      const ref = e.target.closest("[data-skillref]");
      if (ref) {
        mapPanel = null;
        mapSel = { t: "s", k: ref.dataset.skillref };
        return repaintLibrary();
      }
      const row = e.target.closest("tr[data-prop]");
      if (row) row.classList.toggle("open");
    });

  const mapRoot = $(".maplayout");
  if (mapRoot)
    mapRoot.addEventListener("click", (e) => {
      const open = e.target.closest("[data-open]");
      if (open) return go("detail", open.dataset.open);
      // A finding that owns a list opens it in place of the map, which means a
      // re-render of the view rather than a repaint of the canvas.
      if (e.target.closest("[data-weak]")) {
        mapPanel = "weak";
        mapSel = null;
        return repaintLibrary();
      }
      // Anything picked on the canvas is a request to look at something else,
      // so it closes whatever panel the column was holding.
      if (e.target.closest("#mapplot")) mapPanel = null;
      // The evidence opens where it is: two lines are enough to triage, the
      // whole paragraph is one click and never moves the panel underneath it.
      const ev = e.target.closest("[data-expand]");
      if (ev) return void ev.classList.toggle("clamp");
      // The canvas states carry their own way out: read the graph again, or
      // drop the filters that left nothing to draw.
      if (e.target.closest("#mapretry")) return void mountMap(true);
      if (e.target.closest("#mapclear")) {
        clearRailFilters();
        $("#librail").innerHTML = renderRailHtml();
        return paintMap();
      }
      const lensRow = e.target.closest("[data-lens]");
      if (lensRow) return setMapLens(lensRow.dataset.lens);
      const pair = e.target.closest("[data-pair]");
      if (pair) {
        const [a, b] = pair.dataset.pair.split("|");
        mapSel = { t: "e", a, b };
        return paintMap();
      }
      const ment = e.target.closest("[data-ment]");
      if (ment) {
        const [a, b] = ment.dataset.ment.split("|");
        mapMentions = true;
        mapSel = { t: "m", a, b };
        $("#librail").innerHTML = renderRailHtml();
        return paintMap();
      }
      const node = e.target.closest(".mnode");
      if (node) {
        mapSel = { t: "s", k: node.dataset.mapSkill };
        return paintMap();
      }
      const edge = e.target.closest(".medge");
      if (edge) {
        const found = mapEdges()[+edge.dataset.e];
        mapSel = found ? { t: "e", a: found.a, b: found.b } : null;
        return paintMap();
      }
      const mline = e.target.closest(".mment");
      if (mline) {
        const found = mapMentionEdges()[+mline.dataset.m];
        mapSel = found ? { t: "m", a: found.a, b: found.b } : null;
        return paintMap();
      }
      if (e.target.closest("#mapplot svg")) {
        mapSel = null;
        paintMap();
      }
    });
  $("#viewtoggle").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.dataset.view === libView) return;
    setLibView(b.dataset.view);
    if (libView === "grid" && sortMode === "updated") {
      sortMode = "name";
      sortDir = 1;
    }
    repaintLibrary();
  });
  const lt = $("#ledger");
  if (lt)
    lt.addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (!th) return;
      if (sortMode === th.dataset.sort) sortDir = -sortDir;
      else {
        sortMode = th.dataset.sort;
        sortDir = 1;
      }
      repaintLibrary();
    });
  filterLibrary();
  if (libSelName) libHighlight(libSelName);
  libSelApply();
}
function filterLibrary() {
  const q = searchQ.trim().toLowerCase();
  let anyVisible = false;
  document
    .querySelectorAll("#groups .catsec, #groups tbody.lgroup")
    .forEach((sec) => {
      let vis = false;
      sec.querySelectorAll("[data-skill]").forEach((c) => {
        const okSearch = !q || c.dataset.hay.includes(q);
        const okStatus = !statusFilter || c.dataset.status === statusFilter;
        const okAxes = axisList().every(
          (a) =>
            !axisFilters[a.id] ||
            c.getAttribute("data-" + a.id) === axisFilters[a.id],
        );
        const okLink = !linkFilter || c.dataset.link === linkFilter;
        const okSync = !syncFilter || c.dataset.sync === syncFilter;
        const hit = okSearch && okStatus && okAxes && okLink && okSync;
        c.hidden = !hit;
        if (hit) vis = true;
      });
      sec.hidden = !vis;
      if (vis) anyVisible = true;
    });
  const filtering = !!(
    q ||
    statusFilter ||
    Object.values(axisFilters).some(Boolean) ||
    linkFilter ||
    syncFilter
  );
  // On an empty result, hide the whole groups block (table header / cards)
  // so only the message shows — full width, not an orphan header + box.
  const groupsEl = $("#groups");
  if (groupsEl) groupsEl.hidden = filtering && !anyVisible;
  const nr = $("#noresult");
  if (nr) {
    nr.hidden = anyVisible || !filtering;
    nr.textContent = filtering ? "No skills match these filters." : "";
  }
}
// Reads the sync state already in hand, like the banner beside it, so the note
// paints with the rest of the header. Fetching it again after the render left
// the line empty for a beat, which read as a flash on every refresh.
function syncNoteHtml() {
  if (!sync || !sync.versioned || !sync.remote) return "";
  if (sync.dirty === 0 && sync.ahead === 0 && sync.behind === 0)
    return "<b>Everything is in sync.</b>";
  return `<a data-go="status" style="color:var(--accent);font-weight:600;cursor:pointer">Changes to sync →</a>`;
}

// Hide the rows a query does not match, the way filterLibrary does for the
// vault: in place, without touching the input. Section bodies whose rows are
// all hidden go with them, so no empty heading is left behind.
function filterSources() {
  const q = searchQ.trim().toLowerCase();
  const table = $("#srcledger");
  if (!table) return;
  let anyVisible = false;
  table.querySelectorAll("tbody.lgroup").forEach((sec) => {
    let vis = false;
    sec.querySelectorAll("tr[data-skill]").forEach((r) => {
      const hit = !q || (r.dataset.hay || "").includes(q);
      r.hidden = !hit;
      if (hit) vis = true;
    });
    sec.hidden = !vis;
    if (vis) anyVisible = true;
  });
  const scroll = table.closest(".tscroll");
  if (scroll) scroll.hidden = !!q && !anyVisible;
  const nr = $("#srcnoresult");
  if (nr) {
    nr.hidden = anyVisible || !q;
    nr.textContent = q ? "No skills match this search." : "";
  }
}

/* ---------- detail (three-pane) ---------- */
// Last skill opened in detail — lets the "My skills" tab restore the
// detail after visiting Status/Config (cleared on "← Your library").
let lastDetail = null;
function goSkillsTab() {
  // The archive and the remembered detail are Personal's own state (lastDetail
  // only ever holds a vault skill), so a source's tab click just lands on its
  // list — restoring either there would open the wrong thing.
  if (curSource !== "personal") return void go("skills");
  // Coming back to My skills restores where you left it: the archive if you
  // were in it, and the skill you were reading if it is still in that set.
  const set = libArchived ? state.archived || [] : state.skills || [];
  if (lastDetail && set.some((s) => s.name === lastDetail))
    go("detail", lastDetail);
  else go(libArchived ? "archived" : "skills");
}
/* ---------- read-only sources (browse pool + plugins) ---------- */
async function loadSources() {
  const r = await api("/api/sources");
  if (r.ok) sources = r.data.sources || [];
}
// Source switcher: a full-width band above the two-column layout. Every
// source is shown in a stable registry order (personal first); selecting one
// only moves the highlight, never reorders the chips. Wraps to a second row
// when they don't fit.
// A runtime source shows its product name, not the dot-directory it lives in:
// ".claude" is a path, "Claude" is what the user calls it. rtName() already
// carries the proper-noun map (OpenClaw, OpenCode) and any custom names from
// the config, so the two places that name a runtime agree.
function srcLabel(s) {
  return !s ? "" : s.kind === "runtime" ? rtName(s.id) : s.label;
}
function sourceChipsHtml() {
  if (sources.length < 2) return "";
  const chip = (s) =>
    `<button class="srcchip${s.id === curSource ? " on" : ""}" type="button" data-source="${esc(s.id)}">${esc(srcLabel(s))}<span class="n">${s.count}</span></button>`;
  return `<div class="srcband"><div class="srcchips">${sources.map(chip).join("")}</div></div>`;
}
// Split a source's skills into the sections the list renders, keeping the
// server's alphabetical order for the named collections.
//
// What nothing bundled leads. It is the one section with no collection behind
// it, so it is also the one rendered without a heading: a heading would name a
// group that is precisely the absence of one.
//
// Two things land in it. The server's own (unbundled) group — dirs sitting
// loose in a runtime's folder, pool skills the lockfile does not claim — and,
// in the pool only, repos that shipped exactly one skill: there a group is the
// repo a skill happened to arrive in, which is accidental, and a wall of
// one-row sections buries the collections that matter. A plugin never collapses
// — it is the unit you install and remove, so a plugin of one is still a plugin.
//
// Collapsing reads the group's real size, never the filtered rows: searching
// down to a single hit must not turn a real collection into a bucket.
function srcSections(src, skills) {
  const groups = (src && src.groups) || [];
  const collapseSingles = !!src && src.axis === "Source";
  const byKey = new Map();
  for (const s of skills || []) {
    const k = s.group || "";
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(s);
  }
  const out = [];
  const bucket = [];
  for (const g of groups) {
    const items = byKey.get(g.key) || [];
    if (!items.length) continue;
    const loose = g.key === "(unbundled)" || (collapseSingles && g.count === 1);
    if (loose) bucket.push.apply(bucket, items);
    else out.push({ key: g.key, label: g.label, skills: items });
  }
  if (bucket.length)
    out.unshift({
      key: "(unbundled)",
      label: "Unbundled",
      // By name: the groups they were pulled from are not on screen, so their
      // order would be an accident the reader cannot see.
      skills: bucket.sort((a, b) => a.name.localeCompare(b.name)),
    });
  return out;
}
// The display name of the open skill's group. Worth showing on the detail: the
// runtime alone does not say where a skill came from, and "which plugin ships
// this" is the first thing you ask while reading it.
function srcGroupLabel(src) {
  const g = ((src && src.groups) || []).find((x) => x.key === srcGroup);
  return g ? g.label : "";
}
// A group's tint, rank-based over the source's own groups so the same 8-hue
// palette that separates the library's taxonomy separates these sections, and
// the rail facet matches its section header.
function srcHueStyle(src, key) {
  const groups = (src && src.groups) || [];
  const i = groups.findIndex((g) => g.key === key);
  const hue =
    i >= 0
      ? TAX_HUES[(i * 3) % TAX_HUES.length]
      : TAX_HUES[hueHash(key || "other") % TAX_HUES.length];
  return tintVars(hue);
}
// The sections a rail filter leaves visible. Filtering runs on sections, not on
// each skill's own group: a collapsed bucket's rows still carry the real repo
// they came from, so matching skill.group against the filter would never find
// them.
function srcVisibleSections(src, skills, filter) {
  const secs = srcSections(src, skills);
  return filter ? secs.filter((s) => s.key === filter) : secs;
}
function mono(name) {
  return esc((String(name).match(/[a-z0-9]/i) || ["?"])[0].toUpperCase());
}
function selectSource(id) {
  curSource = id;
  // Each source declares its own axes, so each keeps its own grouping — and
  // its own mode and status filter: a source read as a table is not the one
  // read as a map, and a status one holds another may not.
  loadGroupAxis();
  loadLibView();
  loadStatusFilter();
  searchQ = "";
  current = null;
  srcCursor = null;
  srcGroup = "";
  srcGrouped = true;
  srcFilter = "";
  // Personal remembers whether you were reading the archive. A source has no
  // archive of its own, so the flag just rides along until you come back.
  go(id === "personal" && libArchived ? "archived" : "skills");
}
// Source-list arrow navigation: one highlighted row (reusing the ledger's
// .sel styling), scrolled into view; Enter opens it.
function srcListRows() {
  return [...document.querySelectorAll("#srcledger tr[data-skill]")].filter(
    (r) => !r.hidden && r.offsetParent !== null,
  );
}
// A row is identified by group AND name: the same name can sit in two groups,
// so matching on the name alone would highlight both.
function srcSameRow(row, cur) {
  return (
    !!cur && row.dataset.skill === cur.name && row.dataset.group === cur.group
  );
}
function srcHighlight(cur) {
  srcCursor = cur;
  const rows = [...document.querySelectorAll("#srcledger tr[data-skill]")];
  rows.forEach((r) => r.classList.toggle("sel", srcSameRow(r, cur)));
  rows
    .find((r) => srcSameRow(r, cur))
    ?.scrollIntoView({
      block: "nearest",
    });
}
function srcRowKey(row) {
  return { name: row.dataset.skill, group: row.dataset.group || "" };
}
function srcListNav(key) {
  // One column: only Up/Down move in it, and a sideways key never conjures a
  // cursor onto the first row.
  if (key !== "ArrowUp" && key !== "ArrowDown") return false;
  const rows = srcListRows();
  if (!rows.length) return false;
  const idx = rows.findIndex((r) => srcSameRow(r, srcCursor));
  const step = key === "ArrowUp" ? -1 : 1;
  const ni = idx < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, idx + step));
  srcHighlight(srcRowKey(rows[ni]));
  return true;
}
async function renderSourceLibrary(seq) {
  const src = sources.find((s) => s.id === curSource);
  const r = await api(
    `/api/source-skills?src=${encodeURIComponent(curSource)}`,
  );
  if (!navCurrent(seq)) return;
  const all = (r.ok && r.data.skills) || [];
  // Every row is rendered; the query hides them in place (filterSources).
  // Filtering at render time meant every keystroke rebuilt the view — and the
  // search input with it, so the field lost focus after one character and the
  // rest of the word went to the global shortcuts.
  const row = (s) =>
    `<tr data-skill="${esc(s.name)}" data-group="${esc(s.group || "")}" data-hay="${esc(
      `${s.title || s.name} ${s.name} ${s.description || ""}`.toLowerCase(),
    )}"><td><span class="lname">${skillTile(s)}${esc(s.title || s.name)}</span></td><td class="ldesc">${esc(s.description || "")}</td><td class="lwhen">${esc(fmtWhen(s.modified))}</td></tr>`;
  const secs = srcVisibleSections(src, all, srcFilter);
  // Grouped: one tbody per section, headed like the library's. Ungrouped: one
  // flat alphabetical run, for when you know the name and not the batch. Both
  // read the same filtered sections, so a facet narrows either view.
  const rows = srcGrouped
    ? secs
        .map((sec) => {
          // The unbundled lead the list bare: a heading there would name the
          // one section that has no collection to name.
          const head =
            sec.key === "(unbundled)"
              ? ""
              : `<tr class="lsec"><td colspan="3"><span class="lsechead" style="${srcHueStyle(src, sec.key)}"><span class="catdot"></span><h2>${esc(sec.label)}</h2><span class="n">${sec.skills.length} skill${sec.skills.length === 1 ? "" : "s"}</span></span></td></tr>`;
          return `<tbody class="lgroup">${head}${sec.skills.map(row).join("")}</tbody>`;
        })
        .join("")
    : `<tbody class="lgroup">${secs
        .flatMap((sec) => sec.skills)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(row)
        .join("")}</tbody>`;
  const label = src ? srcLabel(src) : curSource;
  const chips = sourceChipsHtml();
  // Facets filter, so they ride above the grouping and show in both modes: you
  // narrow to one plugin whether or not you want the list split by plugin.
  // Counts come from the unfiltered set, so they stay put as you click. A source
  // with no axis (just its own natives) has nothing to offer.
  const facets = srcSections(src, all)
    .map(
      (sec) =>
        `<button class="ritem${srcFilter === sec.key ? " on" : ""}" data-facet="${esc(sec.key)}" style="${srcHueStyle(src, sec.key)}" type="button"><span class="d"></span>${esc(sec.label)}<span class="n">${sec.skills.length}</span></button>`,
    )
    .join("");
  const groupBy =
    src && src.axis
      ? `<div class="rl">Group by</div><div class="seg" id="srcgroupby"><button data-grouped="0"${srcGrouped ? "" : ' class="on"'} type="button">None</button><button data-grouped="1"${srcGrouped ? ' class="on"' : ""} type="button">${esc(src.axis)}</button></div>` +
        `<div class="rl">${esc(src.axis)}</div>${facets}`
      : "";
  setFixed(true);
  app().innerHTML = `<div class="liblayout${chips ? " hasband" : ""}">
    ${chips}
    <aside class="librail">${groupBy}</aside>
    <main class="libmain">
      <div class="libhead"><div><h1 class="view">${esc(label)}</h1><p class="sub">${secs.reduce((n, s) => n + s.skills.length, 0)} of ${all.length} skill${all.length === 1 ? "" : "s"} · read-only. Open one to read its SKILL.md.</p></div></div>
      <div class="srobanner">Read-only source: no status, links, sync or editing here. This is a reference, not part of your vault.</div>
      <div class="libbar"><div class="search"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5.2" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3.4 3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><input id="search" placeholder="Search ${esc(label)}…" value="${esc(searchQ)}" /></div></div>
      <div class="tscroll"><table class="ledger" id="srcledger"><thead><tr><th style="width:22%">Skill</th><th>Description</th><th style="width:11%">Updated</th></tr></thead>${rows}</table></div>
      <div id="srcnoresult" class="empty" hidden></div>
    </main></div>`;
  const inp = $("#search");
  if (inp)
    inp.addEventListener("input", (e) => {
      searchQ = e.target.value;
      filterSources();
    });
  // A facet click or a grouping switch re-renders: re-apply the query so the
  // list agrees with the field that is still holding it.
  filterSources();
  document.querySelectorAll("#srcgroupby button").forEach((b) =>
    b.addEventListener("click", () => {
      srcGrouped = b.dataset.grouped === "1";
      render();
    }),
  );
  // Clicking the facet you are already on clears it, so the rail is its own way
  // out — the same toggle the library's rail has. The cursor drops: the row it
  // pointed at may not be in the list any more.
  document.querySelectorAll(".librail [data-facet]").forEach((b) =>
    b.addEventListener("click", () => {
      srcFilter = srcFilter === b.dataset.facet ? "" : b.dataset.facet;
      srcCursor = null;
      render();
    }),
  );
  if (srcCursor) srcHighlight(srcCursor);
}
// The rail's file list, shared by the vault detail and a read-only source.
// SKILL.md leads, the skill's other root files follow, then one group per
// folder — root files must NOT trail the groups or they read as part of the
// last one. Group headers carry the real leaf-folder path ("assets / css"), so
// a nested folder reads honestly instead of collapsing into its top segment.
// `attr` is the data attribute the click handler reads, the only thing the two
// callers differ on. The gallery is NOT in here: it takes its own section above
// this one, see galleryPanelHtml.
function filePanelHtml(files, attr) {
  const row = (p) =>
    `<div class="file${p === (currentFile || "SKILL.md") ? " sel" : ""}" data-${attr}="${esc(p)}" title="${esc(p)}"><span class="fic">${fileIcon(p)}</span><span class="fname">${esc(p.slice(p.lastIndexOf("/") + 1))}</span></div>`;
  const all = files || [];
  const dirs = {};
  all
    .filter((f) => f.path.includes("/"))
    .forEach((f) => {
      const dn = f.path.slice(0, f.path.lastIndexOf("/"));
      (dirs[dn] = dirs[dn] || []).push(f);
    });
  let html = all
    .filter((f) => f.path === "SKILL.md")
    .map((f) => row(f.path))
    .join("");
  html += all
    .filter((f) => !f.path.includes("/") && f.path !== "SKILL.md")
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => row(f.path))
    .join("");
  const shown = [];
  Object.keys(dirs)
    .sort()
    .forEach((dn) => {
      html += `<div class="flabel" title="${esc(dn)}">${esc(compactDirLabel(dn, shown))}</div>`;
      shown.push(dn);
      dirs[dn]
        .sort((a, b) => a.path.localeCompare(b.path))
        .forEach((f) => (html += row(f.path)));
    });
  return html;
}
// A folder heading in a 240px rail, against a vault that nests three deep:
// "assets / profile-photos / ai-generated" wraps to two lines and spends both
// of them on a parent the heading above already spelled out. So a heading drops
// that parent and keeps a leading slash in its place — `/ ai-generated` under
// `assets / profile-photos`, spaced like the separators inside a path so the
// two sit on one rhythm.
//
// The slash stands for a parent ALREADY WRITTEN OUT above, never for one merely
// shared. `assets/profile-photos` following `assets/avatar-rings` shares
// "assets" with it, but no heading ever said "assets" on its own, so eliding it
// left `/ profile-photos` reading as a child of avatar-rings — a sibling
// wearing the mark of a descendant. It is written in full instead, and only a
// real descendant of a heading above it is shortened.
//
// The whole path is still there on hover, and sorting still reads it: what is
// shortened is the label, never the value.
function compactDirLabel(dir, shown) {
  // Sorted headings put an ancestor before its descendants, so the deepest
  // match is the nearest one — and boundary-checked, since "assets/profile"
  // is not a parent of "assets/profile-photos".
  let parent = "";
  for (const prev of shown || [])
    if (dir.startsWith(prev + "/") && prev.length > parent.length)
      parent = prev;
  const tail = dir
    .slice(parent ? parent.length + 1 : 0)
    .split("/")
    .join(" / ");
  return parent ? `/ ${tail}` : tail;
}
// A skill whose assets are pictures cannot be read one file at a time: the rail
// lists forty filenames that all describe the same face, and telling them apart
// means opening each one. The gallery is that folder shown as what it is.
//
// It is a view of the skill, not a file in it, so it sits above SKILL.md in the
// rail and takes `currentFile` under a key no path can equal — the rail marks
// it selected while no file row is, and the viewer bar names it.
const GALLERY_KEY = " gallery";
// Below two images there is nothing to compare: the grid would be the file
// itself, one click further away.
const GALLERY_MIN = 2;
function imagesOf(files) {
  return (files || []).filter((f) => f.kind === "image");
}
// One row, above the Files heading rather than inside the list under it. That
// heading is the separation: everything under it is a file, and the row that
// sits before it is not one. A heading of its own over a single row, and a rule
// under it, were both saying the same thing a third time.
function galleryPanelHtml(files) {
  const n = imagesOf(files).length;
  if (n < GALLERY_MIN) return "";
  return `<div class="file${currentFile === GALLERY_KEY ? " sel" : ""}" id="gal-entry" data-gallery="1" title="Every image in this skill, ${n} in all"><span class="fic">${GALLERY_IC}</span><span class="fname">Gallery</span><span class="sz">${n}</span></div>`;
}
// One section per folder, in the rail's own order: root images first, then the
// folders alphabetically. The folder path is the heading — a skill that keeps
// finals beside a candidates/ archive is two different sets, and a flat grid of
// both says they are one.
function galleryGroups(files) {
  const dirs = new Map();
  for (const f of imagesOf(files)) {
    const dn = f.path.includes("/")
      ? f.path.slice(0, f.path.lastIndexOf("/"))
      : "";
    if (!dirs.has(dn)) dirs.set(dn, []);
    dirs.get(dn).push(f);
  }
  return [...dirs.keys()]
    .sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map((dir) => ({
      dir,
      items: dirs.get(dir).sort((a, b) => a.path.localeCompare(b.path)),
    }));
}
// Reading order: what the grid shows, top to bottom. The arrows in the
// lightbox walk this and not the raw listing, which sorts a folder's contents
// before a sibling file that shares its prefix and would step somewhere the
// eye did not.
function galleryOrder(files) {
  return galleryGroups(files).flatMap((g) => g.items.map((f) => f.path));
}
function galleryHtml(files, rawUrl) {
  const groups = galleryGroups(files);
  // A single group needs no heading: the skill's own name above already says
  // whose images these are, and one label over one grid is a label for nothing.
  const labelled = groups.length > 1;
  return groups
    .map(({ dir, items }) => {
      const tiles = items
        .map(
          (f) =>
            `<button class="galtile" type="button" data-galfile="${esc(f.path)}" title="${esc(f.path)} · ${fmtSize(f.size)}"><span class="galimg${/\.svg$/i.test(f.path) ? " vec" : ""}"><img src="${esc(rawUrl(f.path))}" alt="" loading="lazy" decoding="async"></span><span class="galname">${esc(f.path.slice(f.path.lastIndexOf("/") + 1))}</span></button>`,
        )
        .join("");
      const head = labelled
        ? `<div class="galhead"><span class="galdir">${dir ? esc(dir.split("/").join(" / ")) : "root"}</span><span class="galn">${items.length} image${items.length === 1 ? "" : "s"}</span></div>`
        : "";
      return `<section class="galsec">${head}<div class="galgrid">${tiles}</div></section>`;
    })
    .join("");
}
// Where the bytes of one image come from, for whichever skill is open. The two
// detail views read different endpoints; everything else about the gallery is
// the same, so this is the only place that knows which.
function galleryRawUrl(p) {
  const q = `path=${encodeURIComponent(p)}`;
  return curSource === "personal"
    ? `/api/file-raw?name=${encodeURIComponent(current)}&${q}`
    : `/api/source-file-raw?src=${encodeURIComponent(curSource)}&group=${encodeURIComponent(srcGroup)}&name=${encodeURIComponent(srcSkill ? srcSkill.name : "")}&${q}`;
}
// The files the gallery is drawn from, for whichever detail is open.
function galleryFiles() {
  return curSource === "personal"
    ? curFiles
    : (srcSkill && srcSkill.files) || [];
}
function openGallery() {
  const isSrc = curSource !== "personal";
  const files = galleryFiles();
  const listSel = isSrc ? "#srcfilelist" : "#filelist";
  currentFile = GALLERY_KEY;
  currentFileData = null;
  document
    .querySelectorAll(`${listSel} .file`)
    .forEach((b) => b.classList.remove("sel"));
  $("#gal-entry")?.classList.add("sel");
  const fn = $("#fname");
  if (fn) fn.textContent = "Gallery";
  const vb = $("#viewerbar");
  if (vb) vb.hidden = false;
  // Neither control has a subject here: there is no Markdown to switch modes
  // on, and the file export hands over one file, not a folder.
  $("#seg")?.classList.add("vhide");
  const xb = $("#v-export");
  if (xb) xb.hidden = true;
  const viewer = $("#viewer");
  if (!viewer) return;
  viewer.innerHTML = galleryHtml(files, galleryRawUrl);
  // A thumbnail that will not load must say so where it sits: an empty tile in
  // a grid of faces reads as a missing asset, which is a different problem.
  viewer.querySelectorAll(".galtile img").forEach((img) => {
    img.onerror = () => {
      const box = img.parentElement;
      box.classList.add("bad");
      box.textContent = "unreadable";
    };
  });
  // The history rail belongs to the vault detail, and the gallery is the whole
  // skill rather than one file in it.
  if (!isSrc) renderHistory(current);
  scrollViewerTop();
}

/* ---------- lightbox ---------- */
// A tile does not open the file. Looking through photographs is a different act
// from reading a file: you compare them, one after another, at a size worth
// looking at. So the grid opens the picture over the page, and the next one is
// an arrow key away rather than a trip back to the grid and out again. The file
// is still one click down — the export button here hands over the same bytes
// the viewer's own export would.
let lbAt = 0;
let lbPaths = [];
let lbReturn = null;
function lightboxDownloadUrl(p) {
  const q = `path=${encodeURIComponent(p)}`;
  return curSource === "personal"
    ? `/api/file-download?name=${encodeURIComponent(current)}&${q}`
    : `/api/source-file-download?src=${encodeURIComponent(curSource)}&group=${encodeURIComponent(srcGroup)}&name=${encodeURIComponent(srcSkill ? srcSkill.name : "")}&${q}`;
}
const LB_HTML = `<div class="lbbar"><span class="lbname" id="lb-name"></span><span class="lbcount" id="lb-count"></span><span class="lbacts"><button class="lbbtn" id="lb-dl" type="button" title="Export this file" aria-label="Export this file"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg></button><button class="lbbtn" id="lb-close" type="button" title="Close" aria-label="Close"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span></div><div class="lbstage"><button class="lbnav" id="lb-prev" type="button" aria-label="Previous image"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button><span class="lbpic" id="lb-pic"></span><button class="lbnav" id="lb-next" type="button" aria-label="Next image"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button></div>`;
function lbRoot() {
  let el = $("#lightbox");
  if (el) return el;
  el = document.createElement("div");
  el.id = "lightbox";
  el.className = "lightbox";
  // Focusable as a container so focus can leave the page behind without
  // landing on a control; announced as a dialog for the same reason.
  el.tabIndex = -1;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "Image viewer");
  el.hidden = true;
  el.innerHTML = LB_HTML;
  document.body.appendChild(el);
  // Wired once for the page: the box outlives every detail render.
  el.addEventListener("click", (e) => {
    if (e.target.closest("#lb-prev")) return lbShow(lbAt - 1);
    if (e.target.closest("#lb-next")) return lbShow(lbAt + 1);
    if (e.target.closest("#lb-dl"))
      return void window.location.assign(lightboxDownloadUrl(lbPaths[lbAt]));
    // The backdrop closes: it is the way out reached for first, and the button
    // is for the one who looks for it. The top bar is exempt — a click that
    // lands on the filename while reading it is not a request to leave.
    if (e.target.closest("#lb-close") || !e.target.closest("img,button,.lbbar"))
      lbClose();
  });
  return el;
}
function openLightbox(paths, i) {
  lbPaths = paths;
  lbReturn = document.activeElement;
  const el = lbRoot();
  el.hidden = false;
  document.body.classList.add("lbopen");
  lbShow(i);
  // Focus the box, not the close button: focus has to leave the page behind so
  // Tab and the reader land here, but parking it on Close painted a focus ring
  // on the X that then sat there through every arrow press, as if the next
  // keystroke would shut the picture.
  el.focus();
}
function lbShow(i) {
  if (!lbPaths.length) return;
  lbAt = (i + lbPaths.length) % lbPaths.length;
  const p = lbPaths[lbAt];
  // The picture is written into its slot rather than kept in the shell with a
  // src that is swapped: a tag with no source is a broken-image box for as long
  // as the box is empty, and the previous photograph must not stand in for the
  // one being asked for while it loads.
  const pic = $("#lb-pic");
  if (pic) {
    pic.innerHTML = `<img src="${esc(galleryRawUrl(p))}" alt="${esc(p.slice(p.lastIndexOf("/") + 1))}">`;
    const img = pic.firstElementChild;
    img.onerror = () => {
      pic.textContent = "Image not readable";
      pic.classList.add("bad");
    };
    pic.classList.remove("bad");
  }
  const nm = $("#lb-name");
  if (nm) nm.textContent = p;
  const ct = $("#lb-count");
  if (ct) ct.textContent = `${lbAt + 1} / ${lbPaths.length}`;
}
function lbClose() {
  const el = $("#lightbox");
  if (!el || el.hidden) return;
  el.hidden = true;
  document.body.classList.remove("lbopen");
  // The picture is dropped rather than left loaded: the next open would show
  // the previous photograph for as long as the new one takes to arrive.
  const pic = $("#lb-pic");
  if (pic) pic.innerHTML = "";
  if (lbReturn && document.contains(lbReturn)) lbReturn.focus();
  lbReturn = null;
}
function lbIsOpen() {
  const el = $("#lightbox");
  return !!el && !el.hidden;
}
// Capture phase, ahead of the pane and view handlers: with the picture open,
// Escape means "close the picture" and nothing else, and the arrows walk the
// photographs rather than the file list underneath them.
document.addEventListener(
  "keydown",
  (e) => {
    if (!lbIsOpen()) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      lbClose();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.stopPropagation();
      e.preventDefault();
      lbShow(lbAt + (e.key === "ArrowLeft" ? -1 : 1));
    }
  },
  true,
);
async function renderSourceDetail(name, seq) {
  const src = sources.find((s) => s.id === curSource);
  // Fetch the skill and its source's full skill list together, so the rail
  // can offer the same file + sibling-skill navigation the vault detail has.
  const [r, lr] = await Promise.all([
    api(
      `/api/source-skill?src=${encodeURIComponent(curSource)}&group=${encodeURIComponent(srcGroup)}&name=${encodeURIComponent(name)}`,
    ),
    api(`/api/source-skills?src=${encodeURIComponent(curSource)}`),
  ]);
  if (!navCurrent(seq)) return;
  if (!r.ok) return void toast(r.data.error || "not found");
  srcSkill = r.data;
  currentFile = "SKILL.md";
  // Track the open skill as the list cursor, so returning to the list (Esc)
  // lands on the skill you were last reading, not the one you first opened.
  srcCursor = { name, group: srcGroup };
  const title = srcSkill.title || name;
  const sibs = ((lr.ok && lr.data.skills) || [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const panel = filePanelHtml(srcSkill.files, "srcfile");
  // Same rule as the vault's detail rail: the siblings are the ones the list
  // you came from is showing — the active facet applies, and while the list is
  // grouped the rail stays inside the collection you opened. The heading names
  // that collection, so a hundred-skill source never lands here whole.
  const sibRow = (s) =>
    `<div class="file plain${s.name === name && (s.group || "") === srcGroup ? " sel" : ""}" data-skill="${esc(s.name)}" data-group="${esc(s.group || "")}">${railIcon(s)}<span>${esc(s.title || s.name)}</span></div>`;
  // Group by the section the list puts a skill in, not by its raw group: on a
  // source keyed by Source, srcSections folds every single-skill collection
  // into Unbundled, so filtering on s.group gave one rail per skill ("Unbundled
  // · 1") while the list showed them together.
  const sibSecs = srcVisibleSections(src, sibs, srcFilter);
  const curSec = sibSecs.find((sec) =>
    sec.skills.some((s) => s.name === name && (s.group || "") === srcGroup),
  );
  const sibSet =
    srcGrouped && curSec ? curSec.skills : sibSecs.flatMap((sec) => sec.skills);
  const sibCat =
    (srcGrouped && curSec && curSec.label) || (src ? srcLabel(src) : "Skills");
  srcOrder = sibSecs.flatMap((sec) =>
    sec.skills.map((s) => ({ name: s.name, group: s.group || "" })),
  );
  const sibHtml = sibSet.length
    ? `<div class="railbottom"><p class="railh nav">${esc(sibCat)} · ${sibSet.length}</p>${sibSet.map(sibRow).join("")}</div>`
    : "";
  setFixed(true);
  navStop();
  app().innerHTML = `<div class="layout srclayout">
    <aside class="rail">
      <button class="crumb" data-source="${esc(curSource)}">← ${esc(src ? srcLabel(src) : "Source")}</button>
      <div class="railtop">${galleryPanelHtml(srcSkill.files)}<p class="railh">Files</p><div id="srcfilelist">${panel}</div></div>
      ${sibHtml}
    </aside>
    <main class="doc review">
      <div class="dochead"><button class="panebtn files" id="pane-files" aria-expanded="false" aria-controls="srcfilelist">Files</button><span class="tile mono">${mono(name)}</span><h1>${esc(title)}</h1><span class="badge off">${esc(srcGroupLabel(src) || (src ? srcLabel(src) : "read-only"))}</span></div>
      <div class="descmeta"><span>Read-only · from ${esc([srcGroupLabel(src), src ? srcLabel(src) : "another source"].filter(Boolean).join(" · "))} · not part of your vault</span></div>
      ${srcSkill.description ? `<p class="desc">${esc(srcSkill.description)}</p>` : ""}
      <div class="viewerbar" id="viewerbar"><span class="fname" id="fname"></span><span class="seg vhide" id="seg"><b data-mode="rendered">Rendered</b><span data-mode="source">Source</span></span>${FILE_EXPORT_BTN}</div>
      <div id="viewer"></div>
    </main></div>`;
  document
    .querySelectorAll("#srcfilelist .file[data-srcfile]")
    .forEach((b) =>
      b.addEventListener("click", () => srcSelectFile(b.dataset.srcfile)),
    );
  // The read-only source detail is two panes, but its rail goes off-canvas at
  // the same breakpoint as the vault detail's — without this the file list
  // slides away below 820px with nothing left to call it back.
  wireDetailPanes();
  document
    .querySelector(".railbottom .file.plain.sel")
    ?.scrollIntoView({ block: "nearest" });
  srcSelectFile("SKILL.md");
}
function srcSelectFile(p) {
  const qs = `src=${encodeURIComponent(curSource)}&group=${encodeURIComponent(srcGroup)}&name=${encodeURIComponent(srcSkill.name)}&path=${encodeURIComponent(p)}`;
  return showFile(
    p,
    "#srcfilelist",
    "srcfile",
    `/api/source-file?${qs}`,
    `/api/source-file-download?${qs}`,
  );
}
// Below 1100px the three-pane detail cannot hold three panes: at 860 the
// document column measured 300px, a 35-character line. The two rails become
// overlays you call up instead, so the document keeps the width. Above the
// breakpoint the buttons are display:none and this is dead weight.
function wireDetailPanes() {
  const layout = document.querySelector(".layout");
  if (!layout) return;
  const close = () => {
    layout.classList.remove("show-files", "show-meta");
    for (const b of layout.querySelectorAll(".panebtn"))
      b.setAttribute("aria-expanded", "false");
  };
  const toggle = (cls, btn) => {
    const on = layout.classList.contains(cls);
    close();
    if (!on) {
      layout.classList.add(cls);
      btn.setAttribute("aria-expanded", "true");
    }
  };
  const files = $("#pane-files");
  const meta = $("#pane-meta");
  files?.addEventListener("click", () => toggle("show-files", files));
  meta?.addEventListener("click", () => toggle("show-meta", meta));
  // A click on the veiled document puts the pane away — the gesture the veil
  // is there to advertise.
  layout.addEventListener("click", (e) => {
    if (
      (layout.classList.contains("show-files") ||
        layout.classList.contains("show-meta")) &&
      e.target.closest(".doc") &&
      !e.target.closest(".panebtn")
    )
      close();
  });
  // Escape is already bound globally to "leave this view". With a pane open it
  // has to mean "close the pane" and stop there — otherwise one keystroke both
  // shuts the overlay and throws you back to the library. Capture phase so this
  // runs before the global handler, and the listener is registered once for the
  // page rather than on every detail render, which would stack a new one per
  // skill opened.
  detailPaneEsc = close;
}
let detailPaneEsc = null;
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape" || !detailPaneEsc) return;
    const layout = document.querySelector(".layout");
    if (
      !layout ||
      !(
        layout.classList.contains("show-files") ||
        layout.classList.contains("show-meta")
      )
    )
      return;
    e.stopPropagation();
    e.preventDefault();
    detailPaneEsc();
  },
  true,
);
async function renderDetail(name, seq) {
  current = name;
  lastDetail = name;
  // The cursor follows the skill you are reading only if there already was one:
  // it belongs to keyboard navigation, so leaving the detail lands where the
  // arrows were. Opening a row with the mouse starts from no cursor and leaves
  // none behind — a click is not a selection.
  if (libSelName) {
    libSelName = name;
    libSel = new Set([name]);
    libSelAnchor = name;
  }
  const r = await api(`/api/skill?name=${encodeURIComponent(name)}`);
  if (!navCurrent(seq)) return; // a newer navigation won the race
  if (!r.ok) {
    toast("skill not found");
    return go("skills");
  }
  const d = r.data;
  const arch = d.archived;
  const summary =
    (state.skills || []).find((s) => s.name === name) ||
    (arch && (state.archived || []).find((x) => x.name === name)) ||
    {};
  // Sibling rail follows the library: same taxonomy group as this skill
  // (per the active Group by axis) and the active rail filters. The open
  // skill itself always stays in the list.
  const groupKey = groupAxis === "none" ? null : groupKeyOf(summary);
  const cat = groupAxis === "none" ? "All skills" : humanTax(groupKey || "");
  const order = libraryOrder();
  // Siblings follow the current library set: archived siblings when
  // browsing the archive, active ones otherwise.
  const siblings = libSkills()
    .filter(
      (s) =>
        s.name === name ||
        (passesFilters(s) &&
          (groupAxis === "none" || groupKeyOf(s) === groupKey)),
    )
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  curFiles = d.files || [];
  const filesHtml = filePanelHtml(d.files, "file");
  const sibHtml = siblings.length
    ? `<div class="railbottom"><p class="railh nav">${esc(cat)} · ${siblings.length}</p>${siblings.map((s) => `<div class="file plain${s.name === name ? " sel" : ""}" data-skill="${esc(s.name)}">${railIcon(s)}<span>${esc(s.title)}</span></div>`).join("")}</div>`
    : "";
  const rtRow = (name, on, attrs) =>
    `<div class="rt"><span class="who">${esc(rtName(name))}</span><button class="switch${on ? " on" : ""}" ${attrs}></button></div>`;
  // A suspended skill isn't in the matrix (d.states empty). Its coverage is
  // still deterministic and read-only: an in-place consumer keeps serving it
  // from the vault, symlink consumers don't link it. Show that honestly
  // rather than an empty "Active on".
  const togglesHtml = d.states.length
    ? d.states
        .map((st) => {
          const cv = state.consumers[st.consumer];
          const isInplace =
            cv && typeof cv === "object" && cv.mode === "in-place";
          const on = st.state === "linked" || st.state === "served";
          let attrs;
          if (isInplace && cv.servedVia) {
            // Live in-place consumer: click activates/deactivates it (edits
            // the runtime's config array), like the Config toggle.
            attrs = `data-inplace="${esc(st.consumer)}" title="${on ? "served in place — click to deactivate (edits the runtime config; reload to apply)" : "inactive — click to activate"}"`;
          } else if (isInplace) {
            attrs =
              'disabled title="served in place — read straight from the vault, no link to toggle"';
          } else if (st.state === "external") {
            // Declared as the runtime's own in loom.local.json. There is
            // nothing to switch: flipping it on would write over a folder that
            // was deliberately put outside the vault's reach.
            attrs =
              'disabled title="external — this runtime keeps its own skill by this name (loom.local.json)"';
          } else if (st.state === "disabled") {
            attrs =
              'disabled title="disabled — this runtime is meant not to see this skill (loom.local.json)"';
          } else {
            attrs = `data-toggle="${esc(st.consumer)}" title="${st.state}"`;
          }
          return rtRow(st.consumer, on, attrs);
        })
        .join("")
    : Object.keys(state.consumers)
        .map((c) => {
          const cv = state.consumers[c];
          const isInplace =
            cv && typeof cv === "object" && cv.mode === "in-place";
          const title = isInplace
            ? "served in place — still read from the vault while suspended"
            : "not linked — suspended skills aren't projected to symlink runtimes";
          return rtRow(c, isInplace, `disabled title="${title}"`);
        })
        .join("");
  // "Link all" shortcut: shown only when the skill is projectable
  // (active/draft) and not already linked on every runtime.
  const projectable =
    (summary.status ?? "active") === "active" || summary.status === "draft";
  const linkAllBtn =
    !arch && projectable && summary.health !== "active"
      ? `<button class="linkall" id="d-linkall" title="Link this skill into every runtime it is not on yet">Link all</button>`
      : "";
  setFixed(true);
  navStop();
  app().innerHTML = `<div class="layout">
          <aside class="rail">
            <button class="crumb" data-go="skills">← Your library</button>
            <div class="railtop">
              ${galleryPanelHtml(d.files)}
              <p class="railh">Files</p>
              <div id="filelist">${filesHtml}</div>
            </div>
            ${sibHtml}
          </aside>
          <main class="doc review">
            <div class="dochead">
              <button class="panebtn files" id="pane-files" aria-expanded="false" aria-controls="filelist">Files</button>
              ${skillTile(summary)}
              <h1>${esc(summary.title || d.name)}</h1>
              ${arch ? '<span class="badge off">Archived</span>' : healthBadge(summary.health || "inactive", summary.health === "active" ? "All linked" : undefined)}
              <span class="acts"><button class="btn" id="d-export">Export</button>${arch ? '<button class="btn primary" id="d-restore">Restore</button>' : ""}<button class="panebtn meta" id="pane-meta" aria-expanded="false" aria-controls="metapane">Runtimes</button></span>
            </div>
            <div class="descmeta"><span>updated ${esc(fmtWhen(summary.modified || ""))}</span></div>
            ${arch ? "" : detMetaHtml(summary)}
            ${d.description ? `<p class="desc">${esc(d.description)}</p>` : ""}
            ${arch ? "" : skillMetaHtml(d.frontmatter)}
            ${arch && d.reason ? `<p class="desc" style="color:var(--dim)"><b>Archived:</b> ${esc(d.reason)}</p>` : ""}
            <div class="viewerbar" id="viewerbar"><span class="fname" id="fname"></span><span class="seg vhide" id="seg"><b data-mode="rendered">Rendered</b><span data-mode="source">Source</span></span>${FILE_EXPORT_BTN}</div>
            <div id="viewer"></div>
          </main>
          <aside class="meta" id="metapane">
            <div class="sect"><div class="railhrow"><p class="railh">Active on</p>${linkAllBtn}</div>${arch ? '<p class="rmeta">Archived — not on any runtime.</p>' : togglesHtml}</div>
            <div class="histhd">
              <span class="railh">History</span>
              <span class="hfname" id="histfname"></span>
              <button class="histback" id="hist-back" hidden></button>
            </div>
            <div id="history"></div>
          </aside>
        </div>`;
  if (arch) {
    $("#d-restore")?.addEventListener("click", () => doRestore(name));
  } else {
    $("#d-export")?.addEventListener("click", () => doExport([name]));
    $("#d-linkall")?.addEventListener("click", () => linkEverywhere(name));
  }
  wireDetailPanes();
  // keep the current skill visible in the pinned rail list
  document
    .querySelector(".railbottom .file.plain.sel")
    ?.scrollIntoView({ block: "nearest" });
  const first = d.files.find((f) => f.path === "SKILL.md")
    ? "SKILL.md"
    : d.files[0] && d.files[0].path;
  // selectFile scopes the history to whatever file it opens; the fallback
  // covers a skill with no files (never happens: SKILL.md always exists).
  if (first) await selectFile(first);
  else renderHistory(name, "SKILL.md");
}
// Markdown assets that are source templates should open as code. Keep the rule
// narrow: ordinary Markdown assets and documentation containing fenced HTML
// are reading surfaces and remain rendered.
function defaultMarkdownView(path, content) {
  if (!/(^|\/)assets\/.*\.(md|markdown)$/i.test(path)) return "rendered";
  const body = String(content || "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .trimStart();
  return /^<(?:!doctype\b|!--|html\b|head\b|body\b|main\b|section\b|article\b|div\b|table\b|svg\b|style\b|script\b)/i.test(
    body,
  )
    ? "source"
    : "rendered";
}

// Open a file in the viewer: mark it in the rail, name it, read it, then hand
// off to the Markdown/plain renderers. Shared by the vault detail and a
// read-only source, which differ only in the rail they mark and the endpoint
// they read from.
async function showFile(p, listSel, attr, url, dlUrl) {
  currentFile = p;
  // The gallery entry is its own rail section, outside the file list, so the
  // list's own pass over the rows cannot unmark it.
  $("#gal-entry")?.classList.remove("sel");
  document.querySelectorAll(`${listSel} .file`).forEach((b) => {
    const on = b.dataset[attr] === p;
    b.classList.toggle("sel", on);
    if (on) b.scrollIntoView({ block: "nearest" });
  });
  const fn = $("#fname");
  if (fn) fn.textContent = p;
  const xb = $("#v-export");
  const r = await api(url);
  if (!$("#viewer")) return;
  // A read that lands after the reader moved on paints over what they asked
  // for: opening the gallery while the detail's own SKILL.md is still in
  // flight put the file back a beat later, and clicking two files quickly
  // could leave the slower one on screen. Whoever set currentFile last wins.
  if (currentFile !== p) return;
  if (!r.ok) {
    $("#viewer").innerHTML =
      `<div class="empty">${esc(r.data.error || "cannot read file")}</div>`;
    $("#seg")?.classList.add("vhide");
    if (xb) xb.hidden = true;
    return;
  }
  // The export button follows the file actually on screen: armed only once the
  // read came back, and off in every state that is not a readable file — an
  // unreadable one, and the commit diff, which reuses this same bar and would
  // otherwise hand over the working copy under the label of an older version.
  if (xb) {
    xb.hidden = false;
    xb.onclick = () => {
      window.location.assign(dlUrl);
      toast(`Exporting ${p.split("/").pop()}…`);
    };
  }
  currentFileData = r.data;
  // The Rendered/Source toggle is a Markdown affordance; everything else
  // renders plain (highlighted, or as an image/binary).
  const isMd = /\.(md|markdown)$/i.test(p) && r.data.kind === "text";
  $("#seg")?.classList.toggle("vhide", !isMd);
  if (isMd) setMode(defaultMarkdownView(p, r.data.content));
  else renderPlain();
  scrollViewerTop();
}
async function selectFile(p) {
  const vb = $("#viewerbar");
  if (vb) vb.hidden = false;
  const hb = $("#hist-back");
  if (hb) hb.hidden = true;
  // File view: show the header filename again (a commit diff hides it so the
  // "Back to <file>" button doesn't duplicate and overlap it in the narrow rail).
  const hfShow = $("#histfname");
  if (hfShow) hfShow.hidden = false;
  document
    .querySelectorAll("#history .commit")
    .forEach((c) => c.classList.remove("sel"));
  // Scope the history rail to this file (git log of the file, not the
  // whole skill), so selecting live-state.md shows live-state.md's history.
  renderHistory(current, p);
  const qs = `name=${encodeURIComponent(current)}&path=${encodeURIComponent(p)}`;
  await showFile(
    p,
    "#filelist",
    "file",
    `/api/file?${qs}`,
    `/api/file-download?${qs}`,
  );
}
// When switching files, bring the content column back to the top so each
// file starts from its beginning, not the previous scroll position.
function scrollViewerTop() {
  let el = $("#viewer");
  while (el && el !== document.body) {
    const oy = getComputedStyle(el).overflowY;
    if (
      (oy === "auto" || oy === "scroll") &&
      el.scrollHeight > el.clientHeight
    ) {
      el.scrollTop = 0;
      return;
    }
    el = el.parentElement;
  }
  window.scrollTo(0, 0);
}
function setMode(m) {
  viewMode = m;
  document.querySelectorAll("#seg [data-mode]").forEach((b) => {
    const on = b.dataset.mode === m;
    b.outerHTML = on
      ? `<b data-mode="${b.dataset.mode}">${b.textContent}</b>`
      : `<span data-mode="${b.dataset.mode}">${b.textContent}</span>`;
  });
  if (m === "rendered") {
    // A read-only source skill isn't in the vault state; its title rides on
    // srcSkill instead.
    const skillTitle =
      curSource !== "personal"
        ? (srcSkill && (srcSkill.title || srcSkill.name)) || ""
        : (
            (state.skills || []).find((s) => s.name === current) ||
            (state.archived || []).find((s) => s.name === current) ||
            {}
          ).title || current;
    $("#viewer").innerHTML =
      `<article class="md doc">${renderMd(currentFileData.content, currentFile !== "SKILL.md", currentFile, skillTitle)}</article>`;
    mountMermaid($("#viewer"));
  } else renderPlain();
}
// A photograph opened from the rail takes the column it is read in, the way a
// wide one already did. Capped at twice its own resolution: past that a small
// asset — an icon, a badge, a diagram — is mush rather than a picture, and the
// honest size is the one it was drawn at. `min()` does the arithmetic in CSS,
// so the picture keeps following the column when the window changes.
const PICTURE_UPSCALE = 2;
function fillColumn(img) {
  const fit = () => {
    if (img.naturalWidth)
      img.style.width = `min(100%, ${img.naturalWidth * PICTURE_UPSCALE}px)`;
  };
  if (img.complete) fit();
  else img.addEventListener("load", fit, { once: true });
}
function renderPlain() {
  const d = currentFileData;
  if (d.kind === "image") {
    // The bytes come from their own endpoint (d.src), not inlined in the JSON:
    // a photo in assets/ is megabytes and the browser streams it.
    $("#viewer").innerHTML = `<img class="preview" src="${esc(d.src)}" alt="">`;
    // A read that fails after the listing (deleted meanwhile, or a source path
    // the raw route refuses) would leave a broken-image glyph; say it instead.
    const img = $("#viewer img");
    if (img) {
      img.onerror = () => {
        $("#viewer").innerHTML =
          `<div class="empty">Image not readable, ${fmtSize(d.size)}</div>`;
      };
      fillColumn(img);
    }
    return;
  }
  if (d.kind === "binary") {
    $("#viewer").innerHTML =
      `<div class="empty">Binary file, ${fmtSize(d.size)}</div>`;
    return;
  }
  const ext = (currentFile || "").split(".").pop().toLowerCase();
  // .txt is the one source shown as code but wrapped (long prose lines read
  // without a horizontal scrollbar); every other source stays verbatim.
  const wrap = ext === "txt" ? " wrap" : "";
  $("#viewer").innerHTML =
    `<pre class="plain code${wrap}">${highlight(d.content, LANG_BY_EXT[ext])}</pre>`;
}
async function renderHistory(name, filePath) {
  // The header names the tracked file when it isn't the main SKILL.md, so
  // it's clear the commits below belong to that file, not the whole skill.
  const hf = $("#histfname");
  if (hf) {
    // Just the filename in the narrow rail; full path on hover.
    const scoped = filePath && filePath !== "SKILL.md" ? filePath : "";
    hf.textContent = scoped ? scoped.split("/").pop() : "";
    hf.title = scoped;
  }
  const q = filePath ? `&path=${encodeURIComponent(filePath)}` : "";
  const r = await api(`/api/history?name=${encodeURIComponent(name)}${q}`);
  const box = $("#history");
  if (!box) return;
  if (!r.data.versioned) {
    box.innerHTML = `<div class="empty" style="margin:0 18px">Not tracked yet.</div>`;
    return;
  }
  if (!r.data.commits.length) {
    box.innerHTML = `<div class="empty" style="margin:0 18px">No history yet.</div>`;
    return;
  }
  box.innerHTML = r.data.commits
    .map(
      (c) =>
        `<div class="commit" data-hash-open="${esc(c.hash)}" data-subj="${esc(c.subject)}"><p class="s">${esc(c.subject)}</p><span class="d">${esc(fmtLong(c.date))}</span> · <span class="seewhat">← See what changed</span></div>`,
    )
    .join("");
}
async function showCommit(hash, subj) {
  document
    .querySelectorAll("#history .commit")
    .forEach((c) => c.classList.toggle("sel", c.dataset.hashOpen === hash));
  const r = await api(
    `/api/commit?name=${encodeURIComponent(current)}&hash=${encodeURIComponent(hash)}&path=${encodeURIComponent(currentFile || "")}`,
  );
  if (!r.ok) return toast(r.data.error || "cannot load commit");
  // keep the viewerbar in place (no layout shift): show the commit id in
  // it, hide the Rendered/Source toggle, and put "Back" in the sidebar.
  $("#fname").textContent =
    `commit ${hash.slice(0, 9)}${subj ? " · " + subj : ""}`;
  $("#seg").classList.add("vhide");
  // No export here: the bar names a commit, and the only file this endpoint
  // could hand over is the working copy, which is not what is on screen.
  const xb = $("#v-export");
  if (xb) xb.hidden = true;
  $("#viewer").innerHTML = `<pre class="plain">${colorDiff(r.data.diff)}</pre>`;
  // Diff view: hide the header filename — the "Back to <file>" button below
  // already names it, and both together overflow the narrow rail.
  const hfHide = $("#histfname");
  if (hfHide) hfHide.hidden = true;
  const back = $("#hist-back");
  if (back) {
    const backFile = currentFile || "SKILL.md";
    // Just the filename — a deep references/ path makes this label overflow.
    back.textContent = `← Back to ${backFile.split("/").pop()}`;
    back.title = backFile; // full path still available on hover
    back.hidden = false;
    back.onclick = () => {
      document
        .querySelectorAll("#history .commit")
        .forEach((c) => c.classList.remove("sel"));
      selectFile(currentFile);
    };
  }
}
function colorDiff(text) {
  return esc(text)
    .split("\n")
    .map((l) => {
      const cls = l.startsWith("+")
        ? "dadd"
        : l.startsWith("-")
          ? "ddel"
          : /^(diff|index|@@|commit|Author|Date)/.test(l)
            ? "dmeta"
            : "";
      return cls ? `<span class="${cls}">${l}</span>` : l;
    })
    .join("\n");
}

/* ---------- status (merged) ---------- */
function splitDiff(diff) {
  const map = {};
  const parts = diff.split(/^diff --git a\/(.*?) b\/.*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    map[parts[i]] = ("diff --git a/" + parts[i] + parts[i + 1]).trim();
  }
  return map;
}
const STATUS_WORD = {
  M: "Edited",
  A: "New",
  D: "Removed",
  R: "Renamed",
  "?": "New",
};
const STATUS_CLS = {
  Edited: "off",
  New: "ok",
  Removed: "warn",
  Renamed: "off",
};
// One coverage-table row: per-consumer link-state cells, plus a "Link all"
// shortcut when the skill is projectable (active/draft) and a symlink runtime is
// still missing. Named so a single row can be swapped in place after linking (no
// full re-render), which keeps the Status scroll position.
// True when a skill should offer the "Link all" shortcut: it is projectable
// (active/draft) and still missing on at least one symlink runtime.
function skillNeedsLink(s, consumers) {
  const projectable =
    (s.status ?? "active") === "active" || s.status === "draft";
  if (!projectable) return false;
  return consumers.some((c) => {
    const cv = state.consumers[c];
    if (cv && typeof cv === "object" && cv.mode === "in-place") return false;
    const cell = state.matrix.find(
      (m) => m.skill === s.name && m.consumer === c,
    );
    return (cell ? cell.state : "missing") === "missing";
  });
}
// One coverage-table row. `withAction` adds the trailing action cell; the table
// only includes that column when some row needs linking, and the column is
// shrink-to-content, so it never claims a full column's width.
function coverageRow(s, consumers, withAction) {
  const cells = consumers
    .map((c) => {
      const cell = state.matrix.find(
        (m) => m.skill === s.name && m.consumer === c,
      );
      // Suspended skills aren't in the matrix (they don't count toward health),
      // but their coverage is deterministic: an in-place consumer still serves
      // them from the vault; a symlink consumer doesn't link them.
      const cv = state.consumers[c];
      const isInplace = cv && typeof cv === "object" && cv.mode === "in-place";
      const st = cell ? cell.state : isInplace ? "served" : "missing";
      const cls =
        st === "linked" || st === "served"
          ? "ok"
          : st === "missing" || st === "external" || st === "disabled"
            ? "off"
            : "bad";
      // "external" and "disabled" are declared, not measured — they read as
      // quiet as "not linked" because nothing is wrong with them.
      const word =
        st === "linked"
          ? "linked"
          : st === "served"
            ? "served"
            : st === "missing"
              ? "not linked"
              : st === "foreign"
                ? "conflict"
                : st;
      return `<td class="cst"><span class="badge ${cls}">${esc(word)}</span></td>`;
    })
    .join("");
  const rowAction = skillNeedsLink(s, consumers)
    ? `<button class="linkall" data-linkall="${esc(s.name)}" title="Link ${esc(s.name)} into every runtime it is not on yet">Link all</button>`
    : "";
  return (
    `<tr data-cov="${esc(s.name)}"><td class="mono">${esc(s.name)}</td>` +
    cells +
    `<td class="awhen">${esc(fmtWhen(s.modified))}</td>` +
    (withAction ? `<td class="rowact">${rowAction}</td>` : "")
  );
}
async function renderStatus(seq) {
  const diffR = (await api("/api/diff")).data;
  sync = (await api("/api/sync")).data;
  if (!navCurrent(seq)) return; // a newer navigation won the race
  const consumers = Object.keys(state.consumers);
  const brokenForeign = state.matrix.filter(
    (m) => m.state === "broken" || m.state === "foreign",
  );
  const issues =
    state.problems.length + state.orphans.length + brokenForeign.length;

  // unsaved changes
  let changesHtml = "";
  let fileCount = 0;
  if (!diffR.versioned) {
    changesHtml = `<div class="empty" style="max-width:92ch">This vault isn't tracked. Ask your technical contact to run <span class="mono">git init</span> in the vault.</div>`;
  } else if (!diffR.status.trim()) {
    changesHtml = `<div class="savedstate"><span class="ic">${CHECK}</span><span><b>Everything is saved.</b> No edits since your last sync.</span></div>`;
  } else {
    const dmap = splitDiff(diffR.diff || "");
    const rows = diffR.status
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const code = l.slice(0, 2).trim();
        const word = STATUS_WORD[code[0]] || STATUS_WORD[code] || "Changed";
        const file = l.slice(3);
        fileCount++;
        const skill = (state.skills || []).find(
          (s) => file === s.rel || file.startsWith(s.rel + "/"),
        );
        const rel = skill
          ? file.slice(skill.rel.length + 1) || "SKILL.md"
          : file;
        // Config files (loom.json, CONVENTIONS.md, source-registry.yaml)
        // show their real filename, like every other non-skill file.
        const rowTitle = skill ? skill.title : file;
        const diffText = dmap[file];
        const body = diffText
          ? `<pre class="plain">${colorDiff(diffText)}</pre>`
          : `<pre class="plain"><span class="dmeta">${word === "New" ? "new file — content not yet tracked" : word.toLowerCase()}</span></pre>`;
        return `<details class="crow"><summary><span class="skname">${esc(rowTitle)}</span><span class="badge ${STATUS_CLS[word] || "off"}">${esc(word)}</span><span class="path">${esc(rel)}</span><span class="chev">›</span></summary><div class="diff">${body}</div></details>`;
      })
      .join("");
    changesHtml = `<div class="clist">${rows}</div>`;
  }

  // coverage table — the action column exists only when a row needs linking
  const anyLink = state.skills.some((s) => skillNeedsLink(s, consumers));
  let cov = `<tr><th>Skill</th>${consumers.map((c) => `<th>${esc(rtName(c))}</th>`).join("")}<th>Updated</th>${anyLink ? '<th class="rowacth"></th>' : ""}</tr>`;
  for (const s of state.skills) cov += coverageRow(s, consumers, anyLink);

  // taxonomy health
  const statusCounts = {};
  for (const s of state.skills) {
    const k = s.status || "active";
    statusCounts[k] = (statusCounts[k] || 0) + 1;
  }
  const axisIds = axisList().map((a) => a.id);
  const untagged = state.skills.filter((s) => axisIds.some((id) => !s[id]));
  const axisNames = axisIds
    .map((id) => axisLabel(id).toLowerCase())
    .join(" or ");
  const statusRows = Object.keys(statusCounts)
    .sort()
    .map(
      (k) =>
        `<tr><td class="mono">${esc(k)}</td><td class="awhen">${statusCounts[k]} skill${statusCounts[k] === 1 ? "" : "s"}</td></tr>`,
    )
    .join("");
  const taxHtml = `<section class="coverage"><div class="covhead"><h2>Taxonomy</h2><span class="cnt">${state.skills.length} skills · by lifecycle status</span></div><table class="grid"><tr><th>Status</th><th>Count</th></tr>${statusRows}</table>${untagged.length ? `<div class="taxmiss"><span class="badge warn">Missing taxonomy</span> ${untagged.length} skill${untagged.length === 1 ? "" : "s"} without ${axisNames}: ${untagged.map((s) => `<span class="mono">${esc(s.name)}</span>`).join(", ")}</div>` : ""}</section>`;

  // hygiene findings — advisory (H1 drift, machine paths, opt-in lint)
  const KIND_WORD = {
    "h1-mismatch": "H1 ≠ name",
    "absolute-path": "machine path",
    "description-length": "description too long",
    "body-length": "body too long",
    "missing-section": "missing section",
    "missing-taxonomy": "missing taxonomy",
    "prose-wall": "wall of text",
    "structured-doc": "wrong doc shape",
    "forbidden-pattern": "forbidden pattern",
  };
  // Any axis can produce "unknown-<axisId>" (Task 5's gate validates every
  // declared axis, not just domain/layer), so a fixed map can never carry an
  // entry for every axis a vault might declare — the fallback covers them all.
  const kindWord = (kind) =>
    KIND_WORD[kind] ||
    (kind.startsWith("unknown-") ? `unknown ${kind.slice(8)}` : kind);
  const warnings = state.warnings || [];
  const hygieneHtml = warnings.length
    ? `<section class="coverage"><div class="covhead"><h2>Hygiene</h2><span class="cnt">${warnings.length} advisory finding${warnings.length === 1 ? "" : "s"} · never block linking</span></div><table class="grid"><tr><th>Skill</th><th>Finding</th><th>Detail</th></tr>${warnings
        .map(
          (w) =>
            `<tr><td class="mono">${esc(w.name)}${w.file ? ` <span class="path">${esc(w.file)}</span>` : ""}</td><td><span class="badge warn">${esc(kindWord(w.kind))}</span></td><td class="awhen">${esc(w.detail)}</td></tr>`,
        )
        .join("")}</table></section>`
    : "";

  // rail verdict
  let verdict,
    vitems = "";
  const activeCount = state.skills.filter((s) => s.health === "active").length;
  if (issues === 0) {
    verdict = `<div class="verdict ok"><span class="d"></span>Everything is healthy</div>`;
    vitems = `<span class="vitem"><span class="mini ok"></span>${activeCount} of ${state.skills.length} skills active on every runtime</span><span class="vitem"><span class="mini ok"></span>No conflicts, no broken links</span>`;
  } else {
    verdict = `<div class="verdict warn"><span class="d"></span>${issues} thing${issues === 1 ? "" : "s"} need${issues === 1 ? "s" : ""} attention</div>`;
    vitems =
      `<span class="vitem"><span class="mini ok"></span>${activeCount} of ${state.skills.length} skills active on every runtime</span>` +
      brokenForeign
        .slice(0, 3)
        .map(
          (m) =>
            `<span class="vitem"><span class="mini warn"></span>${esc(m.consumer)}: ${esc(m.state)} copy of ${esc(m.skill)}</span>`,
        )
        .join("");
  }

  // links block
  let linksBlock = "";
  if (issues > 0) {
    const first = brokenForeign[0];
    const line = first
      ? `<b>${esc(rtName(first.consumer))}</b> has a ${first.state} copy of <b>${esc(first.skill)}</b>. skill-loom never overwrites files, so this one is on you.`
      : `${state.problems.length + state.orphans.length} vault issue(s) to resolve.`;
    linksBlock = `<div class="rblock"><p class="rh">Runtime links</p><p class="rline">${line}</p><button class="btn full" id="fixlinks">Fix links</button></div>`;
  }

  // machines block
  let machines;
  if (!sync.versioned)
    machines = `<p class="rline">This vault isn't versioned. Syncing needs git.</p>`;
  else if (!sync.remote)
    machines = `<p class="rline">Add a git remote to the vault to use your skills on another machine.</p>`;
  else if (sync.ahead === 0 && sync.behind === 0 && sync.dirty === 0)
    machines = `<p class="rline">In sync with your other machines. Nothing to push or pull.</p>`;
  else {
    const parts = [];
    if (sync.ahead || sync.dirty)
      parts.push(
        `<b>${sync.ahead + (sync.dirty ? 1 : 0)} change${sync.ahead + sync.dirty === 1 ? "" : "s"} ahead</b>`,
      );
    if (sync.behind) parts.push(`<b>${sync.behind} behind</b>`);
    machines = `<p class="rline">Vault is ${parts.join(" and ")} of your other machines.</p>`;
  }
  // Remote visibility: the actual commits waiting on each side.
  const commitList = (label, items) =>
    items && items.length
      ? `<p class="rh" style="margin-top:12px">${label}</p>` +
        items
          .slice(0, 5)
          .map((t) => `<p class="rmeta">· ${esc(t)}</p>`)
          .join("") +
        (items.length > 5
          ? `<p class="rmeta">… and ${items.length - 5} more</p>`
          : "")
      : "";
  machines +=
    commitList("Incoming from the remote", sync.incoming) +
    commitList("Not yet pushed", sync.outgoing);

  const canSave = diffR.versioned && (fileCount > 0 || sync.ahead > 0);
  setFixed(true);
  app().innerHTML = `<div class="statuslayout">
          <main class="review">
            <div class="rvhead"><h1>Unsaved changes</h1><span class="count">${fileCount ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : "nothing pending"}</span><span class="spacer"></span>${canSave ? `<button class="btn primary" id="savesync">${sync.remote ? "Save &amp; sync" : "Save locally"}</button>` : ""}</div>
            <p class="rvsub">Edits your agents made since the last save. Review, then save them to the vault and push to your other machines.</p>
            ${changesHtml}
            ${hygieneHtml}
            ${taxHtml}
            <section class="coverage"><div class="covhead"><h2>Runtime coverage</h2><span class="cnt">${state.skills.length} skills · ${listJoin(consumers.map(rtName))}</span></div><p class="covlegend"><b>linked</b> symlink to the vault · <b>not linked</b> nothing installed at the runtime path · <b>conflict</b> something that is not the vault's link owns that path; skill-loom never overwrites it · <b>external</b> that runtime's own skill by the same name, declared in <code>loom.local.json</code> and left alone</p><table class="grid">${cov}</table></section>
          </main>
          <aside class="statusrail">
            <div class="rblock"><p class="rh">Vault health</p>${verdict}<div class="vsupport">${vitems}</div></div>
            ${linksBlock}
            <div class="rblock"><p class="rh">Machines</p>${machines}${sync.remote ? `<p class="rmeta">${esc(sync.remote)}</p>` : ""}</div>
          </aside>
        </div>`;
  navStop();
  if ($("#savesync")) $("#savesync").addEventListener("click", doSaveSync);
  refreshStatusSyncLive();
  if ($("#fixlinks"))
    $("#fixlinks").addEventListener("click", () => doLink(true));
}
async function doSaveSync() {
  const dry = await api("/api/sync", { apply: false });
  // The vault's rules gate the save. Surface the problems and offer an
  // explicit "commit anyway" (force) so a UI user is never dead-ended.
  if (dry.data && dry.data.gate) {
    const n = dry.data.gate.length;
    const ok = await confirmActions(
      `${n} rule problem${n === 1 ? "" : "s"} — fix, or commit anyway?`,
      dry.data.gate,
    );
    if (!ok) return;
    const forced = await api("/api/sync", { apply: true, force: true });
    toast(forced.data.message || forced.data.error || "done");
    await loadState();
    // Repaint where the user already is. Syncing is a background chore, not a
    // reason to move them to Status: the toast already reports the outcome.
    return go(curView, current);
  }
  if (!dry.ok)
    return toast(dry.data.message || dry.data.error || "sync failed");
  if (!dry.data.actions || !dry.data.actions.length)
    return toast(dry.data.message || "already in sync");
  const saveTitle = sync.remote ? "Save and sync now?" : "Save locally now?";
  if (!(await confirmActions(saveTitle, dry.data.actions))) return;
  const wet = await api("/api/sync", { apply: true });
  toast(wet.data.message || wet.data.error || "done");
  await loadState();
  go(curView, current);
}
async function doPresetAdd(name, p) {
  const r = await api("/api/consumers", { name, path: p });
  toast(
    r.ok
      ? `${rtName(name)} added. Use Fix links or link --apply to populate it.`
      : r.data.error || "failed",
  );
  await loadState();
}
async function doRuntimeAdd() {
  const name = await promptDialog(
    'Runtime name (lowercase, e.g. "cursor"):',
    "",
    "Next",
  );
  if (!name) return;
  const p = await promptDialog(
    `Skills folder for "${name.trim().toLowerCase()}" (e.g. ~/.cursor/skills):`,
    "",
    "Add",
  );
  if (!p) return;
  const r = await api("/api/consumers", {
    name: name.trim().toLowerCase(),
    path: p.trim(),
  });
  toast(
    r.ok
      ? "Runtime added. Use Fix links or link --apply to populate it."
      : r.data.error || "failed",
  );
  await loadState();
}
async function doNameAdd() {
  const word = await promptDialog(
    'Word to re-case (one kebab segment, e.g. "acmeai"):',
    "",
    "Next",
  );
  if (!word) return;
  const w = word.trim().toLowerCase();
  const cased = await promptDialog(`Show "${w}" as:`, "", "Save");
  if (!cased) return;
  const r = await api("/api/names", { word: w, cased: cased.trim() });
  toast(r.ok ? "Saved." : r.data.error || "failed");
  await loadState();
}
async function doNameDel(word) {
  const r = await api("/api/names", { word, remove: true });
  toast(r.ok ? "Removed." : r.data.error || "failed");
  await loadState();
}
async function doLink(apply) {
  const dry = await api("/api/link", { apply: false });
  if (dry.data.error) return toast(dry.data.error);
  const pending = (dry.data.items || []).filter((i) => i.action !== "ok");
  if (!pending.length) return toast("Everything already linked.");
  const phrase = (i) =>
    i.action === "create"
      ? `Connect "${i.source}" to ${i.target}`
      : i.action === "replace-stale"
        ? `Repair the link for "${i.source}"`
        : i.action === "remove-orphan"
          ? `Remove obsolete link ${i.target}`
          : i.action === "conflict"
            ? `Skip: ${i.target} has its own copy of "${i.source}"`
            : `${i.action} ${i.target}`;
  if (!(await confirmActions("Fix links?", pending.map(phrase)))) return;
  const wet = await api("/api/link", { apply: true });
  if (wet.status === 409 && wet.data.conflicts)
    toast(wet.data.conflicts + " conflict(s) skipped — resolve manually");
  else toast("Links fixed.");
  await loadState();
  go("status");
}

/* ---------- new skill ---------- */
function renderNew() {
  setFixed(false);
  const consumers = Object.keys(state.consumers);
  // The form mirrors the vault's declared axes: one field per axis (Task
  // 1's resolveAxes always returns at least the domain/layer default, so
  // this is never empty), required ones flagged from lint.requireTaxonomy,
  // and scaffolds the sections lint requires. state.axes[].values is the
  // primary source of allowed values — it is unconditional; the lint
  // block's allowedByAxis is only a secondary source (null whenever the
  // vault has no lint block, even one that declares taxonomy).
  const lint = state.lint || null;
  const req = (lint && lint.requireTaxonomy) || [];
  const sections = (lint && lint.requireSections) || [];
  const minChars = lint && lint.descriptionMinChars;
  const axisAllowed = (a) =>
    a.values && a.values.length
      ? a.values
      : ((lint && lint.allowedByAxis) || {})[a.id] || [];
  // Status is offered only when the vault has SOME taxonomy signal (a
  // required axis, or a declared vocabulary for one) — this mirrors the
  // pre-Task-6 showTaxo gate. A vault with no lint and no declared values
  // still gets a field per axis (Step 7), but stays a plain name+
  // description+status-less form otherwise: buildSkillMd (src/ops.ts)
  // reads that as "nothing provided" and writes the commented hint
  // scaffold instead of a live status: draft line, and a status-less
  // skill reads back as "active", not "draft" (server.ts's `?? "active"`)
  // — sending status unconditionally would silently flip that default.
  const showStatus = axisList().some(
    (a) => req.includes(a.id) || axisAllowed(a).length > 0,
  );
  const axisFields = axisList()
    .map((a) => {
      const allowed = axisAllowed(a);
      const required = req.includes(a.id);
      const id = `n-ax-${a.id}`;
      const control = allowed.length
        ? `<select class="txt" id="${id}"${required ? " required" : ""}><option value="">(choose)</option>${allowed.map((v) => `<option value="${esc(v)}">${esc(humanTax(v))}</option>`).join("")}</select>`
        : `<input class="txt" id="${id}"${required ? " required" : ""} spellcheck="false" placeholder="${esc(axisLabel(a.id).toLowerCase())}" />`;
      return `<div class="field-row"><label class="field" for="${id}">${esc(axisLabel(a.id))}${required ? ' <span class="req">required</span>' : ""}</label>${control}</div>`;
    })
    .join("");
  const statusRow = showStatus
    ? `<div class="field-row"><label class="field" for="n-status">Status</label><select class="txt" id="n-status">${STATUS_ORDER.map((v) => `<option value="${esc(v)}"${v === "draft" ? " selected" : ""}>${esc(statusLabel(v))}</option>`).join("")}</select><p class="hint">Lifecycle. New skills start as a draft.</p></div>`
    : "";
  app().innerHTML = `<div class="newwrap">
          <button class="crumb" data-go="skills">← Your library</button>
          <h1>Create a new skill</h1>
          <p class="sub" style="max-width:68ch">It becomes one canonical folder in your vault, versioned in git and linked into every runtime. No copies to keep in sync by hand.</p>
          <div class="newgrid">
            <form id="newform">
              <div class="field-row"><label class="field" for="n-name">Name</label><input class="txt" id="n-name" placeholder="ai-act-readiness" pattern="[a-z0-9][a-z0-9-]*" spellcheck="false" required /><p class="hint">Lowercase, words joined by dashes. Folder name and the id agents match on. <span class="mono" id="n-slug"></span></p></div>
              ${axisFields}${statusRow}
              <div class="field-row"><label class="field" for="n-desc">Description</label><textarea class="txt" id="n-desc" spellcheck="false" placeholder="When should an agent reach for this skill?"></textarea><p class="hint">This is what an agent reads to decide.${minChars ? ` <span id="n-desccount" class="warn"></span>` : ""}</p></div>
              <div class="newactions"><button type="submit" class="btn primary">Create &amp; activate</button><button type="button" class="btn" data-go="skills">Cancel</button><span class="note">Shows a dry-run before anything is written.</span></div>
              <div id="n-out"></div>
            </form>
            <aside class="plan">
              <p class="rh" style="color:var(--dim)">This will create</p>
              <div class="tree" id="n-tree"></div>
              <div class="fmbox" id="n-fm"></div>
              <div class="runrow"><span class="rl">Then activate on</span><span class="rtchips">${consumers.map((c) => `<span class="rtchip"><span class="d"></span>${esc(rtName(c))}</span>`).join("")}</span></div>
            </aside>
          </div>
        </div>`;
  const upd = () => {
    const name = ($("#n-name").value || "").trim() || "your-skill";
    const desc = ($("#n-desc").value || "").trim();
    const status = $("#n-status") ? $("#n-status").value : "draft";
    $("#n-slug").textContent = name;
    $("#n-tree").innerHTML =
      `skills-vault/\n└─ <span class="accent">${esc(name)}/</span>\n   └─ SKILL.md`;
    let fm =
      `<span class="k">---</span>\n` +
      `<span class="k">name:</span> ${esc(name)}\n` +
      `<span class="k">description:</span> ${esc(desc || "…")}\n`;
    for (const a of axisList()) {
      const el = $(`#n-ax-${a.id}`);
      const v = el ? el.value.trim() : "";
      fm += `<span class="k">${esc(a.id)}:</span> ${esc(v || "…")}\n`;
    }
    if (showStatus)
      fm += `<span class="k">status:</span> ${esc(status || "draft")}\n`;
    else fm += `<span class="c"># optional: status</span>\n`;
    fm += `<span class="k">---</span>`;
    if (sections.length)
      fm +=
        `\n<span class="c"># ${esc(name)}</span>\n` +
        sections.map((s) => `<span class="c">## ${esc(s)}</span>`).join("\n");
    $("#n-fm").innerHTML = fm;
    if (minChars && $("#n-desccount")) {
      const n = desc.length;
      $("#n-desccount").textContent = `${n} / min ${minChars}`;
      $("#n-desccount").className = n >= minChars ? "ok" : "warn";
    }
  };
  ["input", "change"].forEach((e) => $("#newform").addEventListener(e, upd));
  upd();
  $("#newform").addEventListener("submit", doAdd);
}
async function doAdd(e) {
  e.preventDefault();
  const taxonomy = {};
  for (const a of axisList()) {
    const el = $(`#n-ax-${a.id}`);
    const v = el ? el.value.trim() : "";
    if (v) taxonomy[a.id] = v;
  }
  const body = {
    name: $("#n-name").value.trim(),
    description: $("#n-desc").value.trim() || undefined,
    taxonomy,
    status: $("#n-status") ? $("#n-status").value : undefined,
  };
  const dry = await api("/api/add", { ...body, apply: false });
  if (!dry.ok) {
    $("#n-out").innerHTML =
      `<div class="issue crit" style="margin-top:14px">${esc(dry.data.message || dry.data.error)}</div>`;
    return;
  }
  const actions = [
    ...dry.data.actions,
    "link the new skill into all configured runtimes",
  ];
  if (!(await confirmActions(`Create "${body.name}"?`, actions))) return;
  const wet = await api("/api/add", { ...body, apply: true });
  if (!wet.ok) {
    $("#n-out").innerHTML =
      `<div class="issue crit" style="margin-top:14px">${esc(wet.data.message || wet.data.error)}</div>`;
    return;
  }
  await api("/api/link", { apply: true });
  toast(wet.data.message || "Created and linked.");
  await loadState();
  go("detail", body.name);
}

/* ---------- config ---------- */
/* ---------- config: rules pane (editable) ---------- */
// The rules the vault enforces, read from loom.json's lint block
// (already in state.lint) and edited as a local working copy
// (rulesDraft) before Task 6's Review-and-save flow sends it to
// /api/rules. Nothing is written to loom.json from this pane on a
// keystroke — only Discard (resets from state.lint) touches the
// draft here; the actual save lands in Task 6.
const RULES_TAXO_FIELDS = [
  { key: "domain", label: "domain" },
  { key: "layer", label: "layer" },
];

// Canonical 9-field lint shape, in a fixed key order, built from
// either state.lint or a draft. Used both to seed rulesDraft and as
// the dirty-check comparison target. rulesDirty() compares
// JSON.stringify output, so this key order MUST stay exactly what
// initRulesDraft produces, or the dock bar shows up spuriously on
// first render.
function normalizedLint(l) {
  l = l || {};
  return {
    requireTaxonomy: [...(l.requireTaxonomy || [])],
    allowedDomains: [...(l.allowedDomains || [])].sort((a, b) =>
      a.localeCompare(b),
    ),
    allowedLayers: [...(l.allowedLayers || [])].sort((a, b) =>
      a.localeCompare(b),
    ),
    requireSections: [...(l.requireSections || [])].sort((a, b) =>
      a.localeCompare(b),
    ),
    descriptionMinChars: l.descriptionMinChars ?? null,
    descriptionMaxChars: l.descriptionMaxChars ?? null,
    bodyMaxLines: l.bodyMaxLines ?? null,
    forbidBodyPatterns: [...(l.forbidBodyPatterns || [])],
    strict: l.strict === true,
  };
}

// Working copy of the lint block while the Rules form is open. Null =
// not initialized yet; initRulesDraft() seeds it from state.lint via
// normalizedLint, so a fresh draft always starts identical to the
// server's copy (no spurious "unsaved edits" on load) since both
// sides run through the same key-ordering function.
let rulesDraft = null;
function initRulesDraft() {
  rulesDraft = normalizedLint(state.lint);
}
function rulesDirty() {
  return (
    JSON.stringify(rulesDraft) !== JSON.stringify(normalizedLint(state.lint))
  );
}

// True while any forbidBodyPatterns entry (committed or mid-add)
// fails `new RegExp(...)`. Review and save stays disabled while this
// is true; the button's click handler itself is wired in Task 6.
let rulesRegexError = false;
// Uncommitted text sitting in the "+ add pattern" row, tracked
// outside the DOM so a re-render triggered by an unrelated edit
// (e.g. toggling strict while mid-type) doesn't drop it.
let rulesPatternAdd = "";

function isValidRegex(v) {
  if (!v) return true; // empty is "not yet a pattern", not invalid
  try {
    new RegExp(v);
    return true;
  } catch {
    return false;
  }
}

function renderRulesDockbar() {
  rulesRegexError =
    (rulesDraft.forbidBodyPatterns || []).some((v) => !isValidRegex(v)) ||
    !isValidRegex(rulesPatternAdd);
  // Dirty alone misses one case: typing straight into the "+ add
  // pattern" row (rulesPatternAdd lives outside rulesDraft, so it
  // never flips rulesDirty()). Without this, an invalid regex typed
  // from a clean vault would show the .rxbad row but no dock bar at
  // all — "Review and save disabled" would have nothing to be
  // observed on. A non-empty add-in-progress counts as unsaved too.
  if (!rulesDirty() && !rulesPatternAdd.trim()) return "";
  return `<div class="dockbar"><span class="impact">Unsaved edits.</span><span class="spc"></span><button class="btn sm" id="rules-discard">Discard</button><button class="btn primary sm" id="rules-review"${rulesRegexError ? " disabled" : ""}>Review and save</button></div>`;
}

function renderRulesForm() {
  if (!rulesDraft) initRulesDraft();
  const d = rulesDraft;

  const taxoRow = RULES_TAXO_FIELDS.map(({ key, label }) => {
    const on = d.requireTaxonomy.includes(key);
    return `<button type="button" class="chip${on ? " accent" : ""}" data-rules-taxo="${key}">${esc(label)}${on ? ` <span class="req-badge">required</span>` : ""}</button>`;
  }).join("");

  // `label` names the control for assistive tech. The visible row title sits in
  // a sibling .edk div, which no accessible-name computation reaches: without
  // it, Rules reads as a column of anonymous "+ add" boxes and unnamed number
  // fields — on the surface that rewrites loom.json.
  const chipList = (field, label, opts) => {
    const mono = opts && opts.mono;
    const display = (opts && opts.display) || ((v) => v);
    const values = d[field] || [];
    return (
      values
        .map(
          (v) =>
            `<span class="chip rm${mono ? " code" : ""}">${esc(display(v))} <button type="button" class="x" aria-label="Remove ${esc(display(v))} from ${esc(label)}" data-rules-chip-rm="${field}" data-rules-chip-value="${esc(v)}">×</button></span>`,
        )
        .join("") +
      `<input class="chip add" type="text" placeholder="+ add" aria-label="Add to ${esc(label)}" spellcheck="false" data-rules-chip-add="${field}" />`
    );
  };

  const rxRows = (d.forbidBodyPatterns || [])
    .map((v, i) => {
      const bad = !isValidRegex(v);
      return (
        `<div class="rxrow${bad ? " rxbad" : ""}"><input class="rxinput" type="text" aria-label="Forbidden pattern ${i + 1}" value="${esc(v)}" spellcheck="false" data-rules-rx-i="${i}" /><button type="button" class="x" aria-label="Remove forbidden pattern ${i + 1}" data-rules-rx-rm="${i}">×</button></div>` +
        (bad ? `<div class="rxerr">invalid regex, cannot save</div>` : "")
      );
    })
    .join("");
  const addBad = !isValidRegex(rulesPatternAdd);
  const rxAddRow =
    `<div class="rxrow add${addBad ? " rxbad" : ""}"><input class="rxinput" type="text" placeholder="+ add pattern" aria-label="Add a forbidden pattern" spellcheck="false" value="${esc(rulesPatternAdd)}" data-rules-rx-add /></div>` +
    (addBad ? `<div class="rxerr">invalid regex, cannot save</div>` : "");

  const strictOn = d.strict === true;

  return `<div class="panel" id="rules-panel">
          <div class="panel-h"><h2>Rules</h2><p>What every skill must satisfy. Saving rewrites the lint block in loom.json and re-arms the gate.</p></div>
          <div class="edscroll">
            <div class="edrow"><div class="edk">Required taxonomy<span class="k2">Axes every skill must declare</span></div><div class="edv">${taxoRow}</div></div>
            <div class="edrow"><div class="edk">Allowed domains<span class="k2">Frontmatter domain must be one of these</span></div><div class="edv">${chipList("allowedDomains", "allowed domains")}</div></div>
            <div class="edrow"><div class="edk">Allowed layers</div><div class="edv">${chipList("allowedLayers", "allowed layers")}</div></div>
            <div class="edrow"><div class="edk">Required sections<span class="k2">Headings each SKILL.md must contain</span></div><div class="edv">${chipList("requireSections", "required sections", { mono: true, display: (v) => "## " + v })}</div></div>
            <div class="edrow"><div class="edk">Description length</div><div class="edv">min <input class="num" type="text" inputmode="numeric" aria-label="Description length, minimum characters" value="${d.descriptionMinChars ?? ""}" data-rules-num="descriptionMinChars" /> to max <input class="num" type="text" inputmode="numeric" aria-label="Description length, maximum characters" value="${d.descriptionMaxChars ?? ""}" data-rules-num="descriptionMaxChars" /><span style="color:var(--faint);font-size:12.5px">characters</span></div></div>
            <div class="edrow"><div class="edk">Body max lines<span class="k2">SKILL.md body cap, waivable per skill</span></div><div class="edv"><input class="num" type="text" inputmode="numeric" aria-label="Body max lines" value="${d.bodyMaxLines ?? ""}" data-rules-num="bodyMaxLines" /></div></div>
            <div class="edrow"><div class="edk">Forbidden patterns<span class="k2">Regex the body may not contain</span></div><div class="edv"><div class="rxlist">${rxRows}${rxAddRow}</div></div></div>
            <div class="edrow"><div class="edk">Strict gate<span class="k2">Blocks non-compliant saves</span></div><div class="edv"><button class="switch${strictOn ? " on" : ""}" aria-label="strict" data-rules-strict="1"></button><span class="pill ${strictOn ? "on" : "off"}"><span class="pd"></span>${strictOn ? "on, blocks non-compliant saves" : "off, advisory only"}</span></div></div>
          </div>
          ${renderRulesDockbar()}
        </div>`;
}

// Patches just the dock bar in place (add/remove/update the disabled
// state) without touching the rest of the form — used from the
// direct-patch mutation handlers below (number inputs, regex text)
// so a live keystroke never blows away input focus.
function patchRulesDockbar() {
  const panel = document.getElementById("rules-panel");
  if (!panel) return;
  const existing = panel.querySelector(".dockbar");
  const html = renderRulesDockbar();
  if (!html) {
    if (existing) existing.remove();
    return;
  }
  if (existing) existing.outerHTML = html;
  else panel.insertAdjacentHTML("beforeend", html);
}

// Full re-render of the Rules pane content (used for click-driven
// mutations — add/remove/toggle — where losing focus doesn't
// matter). #cfg-pane itself is never recreated by this, so the
// delegated listeners bound once in wireRulesPane() keep working.
function rerenderRulesPane(opts) {
  const p = $("#cfg-pane");
  if (!p) return;
  p.innerHTML = renderRulesForm();
  if (opts && opts.focus) {
    const el = p.querySelector(opts.focus);
    if (el) el.focus();
  }
}

function rulesDiscard() {
  initRulesDraft();
  rulesPatternAdd = "";
  rerenderRulesPane();
}
function rulesToggleTaxo(key) {
  const arr = rulesDraft.requireTaxonomy;
  const i = arr.indexOf(key);
  if (i === -1) arr.push(key);
  else arr.splice(i, 1);
  rerenderRulesPane();
}
function rulesChipRemove(field, value) {
  const arr = rulesDraft[field] || [];
  const i = arr.indexOf(value);
  if (i === -1) return;
  arr.splice(i, 1);
  rerenderRulesPane();
}
function rulesChipAddCommit(field, inputEl) {
  const raw = (inputEl.value || "").trim();
  if (!raw) return;
  let v = raw;
  if (field === "requireSections") v = v.replace(/^#+\s*/, "").trim();
  if (!v) return;
  const arr = rulesDraft[field] || (rulesDraft[field] = []);
  if (!arr.includes(v)) arr.push(v);
  inputEl.value = "";
  rerenderRulesPane({ focus: `[data-rules-chip-add="${field}"]` });
}
function rulesToggleStrict(btnEl) {
  rulesDraft.strict = !rulesDraft.strict;
  btnEl.classList.toggle("on", rulesDraft.strict);
  const label = btnEl.parentElement.querySelector(".pill");
  if (label) {
    label.className = "pill " + (rulesDraft.strict ? "on" : "off");
    label.innerHTML = `<span class="pd"></span>${rulesDraft.strict ? "on, blocks non-compliant saves" : "off, advisory only"}`;
  }
  patchRulesDockbar();
}
function rulesNumInput(field, raw) {
  const v = (raw || "").trim();
  if (v === "") rulesDraft[field] = null;
  else if (/^-?\d+$/.test(v)) rulesDraft[field] = parseInt(v, 10);
  // else: mid-type / not a clean integer yet — leave the draft at its
  // last valid value until the field resolves to "" or a clean int.
  patchRulesDockbar();
}
// Toggles the invalid-regex UI (class + inline note) on one row
// in place, without touching the rest of the form, then patches the
// dock bar's disabled state.
function rulesRxRowFeedback(rowEl, ok, hasValue) {
  rowEl.classList.toggle("rxbad", !ok && hasValue);
  const next = rowEl.nextElementSibling;
  const hasErr = next && next.classList && next.classList.contains("rxerr");
  if (!ok && hasValue && !hasErr) {
    const e = document.createElement("div");
    e.className = "rxerr";
    e.textContent = "invalid regex, cannot save";
    rowEl.after(e);
  } else if ((ok || !hasValue) && hasErr) {
    next.remove();
  }
}
function rulesRxInput(i, value, rowEl) {
  rulesDraft.forbidBodyPatterns[i] = value;
  rulesRxRowFeedback(rowEl, isValidRegex(value), true);
  patchRulesDockbar();
}
function rulesRxAddInput(value, rowEl) {
  rulesPatternAdd = value;
  rulesRxRowFeedback(rowEl, isValidRegex(value), !!value);
  patchRulesDockbar();
}
function rulesRxRemove(i) {
  rulesDraft.forbidBodyPatterns.splice(i, 1);
  rerenderRulesPane();
}
function rulesRxAddCommit() {
  const v = rulesPatternAdd.trim();
  if (!v || !isValidRegex(v)) return;
  rulesDraft.forbidBodyPatterns.push(v);
  rulesPatternAdd = "";
  rerenderRulesPane({ focus: "[data-rules-rx-add]" });
}

// Before the dry-run (and before the eventual write), commit any valid
// uncommitted "+ add" text sitting in the form's inputs into
// rulesDraft, reusing the same commit helpers Enter uses — so the
// impact preview and the saved rules match what is on screen. Each
// helper self-guards on an empty value, so calling all four
// unconditionally is safe. A pending invalid regex can't reach here:
// Review and save stays disabled while rulesRegexError is true.
function flushPendingRulesInputs() {
  const p = $("#cfg-pane");
  if (p)
    p.querySelectorAll("[data-rules-chip-add]").forEach((el) =>
      rulesChipAddCommit(el.dataset.rulesChipAdd, el),
    );
  rulesRxAddCommit();
}

// Renders the impact of rulesDraft into the Rules pane, replacing the
// form area (edscroll + dockbar) with the dry-run summary. The panel
// header stays so the pane still reads as "Rules" while reviewing.
function renderRulesReview(impact) {
  const p = $("#cfg-pane");
  if (!p) return;
  const n = impact.newlyFlagged.length;
  const m = impact.nowPass.length;
  let bodyHtml;
  if (n === 0 && m === 0) {
    bodyHtml = `<p class="imp-empty">No skills are affected by this change.</p>`;
  } else {
    const rows = impact.newlyFlagged
      .map(
        (f) =>
          `<div class="imp-item"><span class="badge warn">flagged</span><span class="mono">${esc(f.name)}</span><span class="why">${esc(f.reason)}</span></div>`,
      )
      .join("");
    const passLine = m
      ? `<div class="imp-item"><span class="imp-good">${m} now-flagged skill${m === 1 ? "" : "s"} would pass</span> ${impact.nowPass.map((name) => `<span class="mono">${esc(name)}</span>`).join(", ")}</div>`
      : "";
    bodyHtml = `<h3 class="imp-h">${n} skill${n === 1 ? "" : "s"} would be newly flagged</h3><div class="imp-list">${rows}${passLine}</div>`;
  }
  p.innerHTML = `<div class="panel" id="rules-panel">
          <div class="panel-h"><h2>Rules</h2><p>What every skill must satisfy. Saving rewrites the lint block in loom.json and re-arms the gate.</p></div>
          <div class="rules-review">
            <div class="kicker">Dry run, before writing loom.json</div>
            ${bodyHtml}
            <div class="rr-actions"><button class="btn sm" id="rules-back">Back to edits</button><button class="btn primary sm" id="rules-confirm">Confirm and write loom.json</button><span class="rr-note">writes loom.json at the vault root</span></div>
          </div>
        </div>`;
}

// Review and save: dry-run rulesDraft against the vault and show the
// impact, without writing anything.
async function rulesReviewClick() {
  flushPendingRulesInputs();
  const dry = await api("/api/rules", { lint: rulesDraft, apply: false });
  if (!dry.ok) {
    toast(dry.data.error || "Could not check these rules");
    return;
  }
  // The user may have navigated away from Rules while the dry-run was
  // in flight — don't paint the review over whatever pane they're on
  // now.
  if (curView !== "config" || configPane !== "rules") return;
  renderRulesReview(dry.data.impact);
}
// Back to edits: drop the review, re-render the form from rulesDraft
// (unchanged by the dry-run) via the normal config route.
function rulesReviewBack() {
  go("config");
}
// Confirm and write: actually saves the lint block to loom.json, then
// reloads state and re-initializes the draft so the form and dock bar
// reflect what is now on disk.
async function rulesConfirmClick() {
  const wet = await api("/api/rules", { lint: rulesDraft, apply: true });
  if (!wet.ok) {
    toast(wet.data.error || "Could not write the rules");
    return;
  }
  toast("Rules saved.");
  await loadState(); // refresh state.lint so the form reflects the saved rules
  rulesDraft = null;
  go("config");
}

// Binds delegated click/input/keydown listeners once on #cfg-pane
// (guarded by a dataset flag so repeat calls from rerenderRulesPane()
// are no-ops). Delegation means the listeners keep working across
// both full pane re-renders and dockbar-only patches, since neither
// ever replaces #cfg-pane itself.
function wireRulesPane() {
  const p = $("#cfg-pane");
  if (!p || p.dataset.rulesWired) return;
  p.dataset.rulesWired = "1";
  p.addEventListener("click", (e) => {
    const taxo = e.target.closest("[data-rules-taxo]");
    if (taxo) return rulesToggleTaxo(taxo.dataset.rulesTaxo);
    const rm = e.target.closest("[data-rules-chip-rm]");
    if (rm)
      return rulesChipRemove(rm.dataset.rulesChipRm, rm.dataset.rulesChipValue);
    const rxrm = e.target.closest("[data-rules-rx-rm]");
    if (rxrm) return rulesRxRemove(Number(rxrm.dataset.rulesRxRm));
    const strict = e.target.closest("[data-rules-strict]");
    if (strict) return rulesToggleStrict(strict);
    if (e.target.closest("#rules-discard")) return rulesDiscard();
    if (e.target.closest("#rules-review")) return rulesReviewClick();
    if (e.target.closest("#rules-back")) return rulesReviewBack();
    if (e.target.closest("#rules-confirm")) return rulesConfirmClick();
  });
  p.addEventListener("input", (e) => {
    const num = e.target.closest("[data-rules-num]");
    if (num) return rulesNumInput(num.dataset.rulesNum, num.value);
    const rx = e.target.closest("[data-rules-rx-i]");
    if (rx)
      return rulesRxInput(
        Number(rx.dataset.rulesRxI),
        rx.value,
        rx.closest(".rxrow"),
      );
    const rxadd = e.target.closest("[data-rules-rx-add]");
    if (rxadd) return rulesRxAddInput(rxadd.value, rxadd.closest(".rxrow"));
  });
  p.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const add = e.target.closest("[data-rules-chip-add]");
    if (add) {
      e.preventDefault();
      return rulesChipAddCommit(add.dataset.rulesChipAdd, add);
    }
    const rxadd = e.target.closest("[data-rules-rx-add]");
    if (rxadd) {
      e.preventDefault();
      return rulesRxAddCommit();
    }
  });
  // Also commit an add-input's pending text when it loses focus (tab
  // away, click elsewhere, switch Config pane), not only on Enter —
  // so typed-but-unconfirmed text isn't silently lost. focusout
  // bubbles (blur doesn't), so it works with this same delegated
  // listener. Both commit helpers already no-op on an empty/whitespace
  // value, and rulesChipAddCommit now clears its input on commit (like
  // rulesRxAddCommit already clears rulesPatternAdd), so the Enter
  // path leaves nothing behind for a trailing blur to re-commit.
  p.addEventListener("focusout", (e) => {
    // If focus is moving to a button (the dock bar's Review / Discard),
    // do not commit-and-rerender here: it would remove the button mid
    // click and swallow the first click. Review and save flushes the
    // pending value first (flushPendingRulesInputs) and Discard drops it,
    // so nothing is lost. Tab-away, click-elsewhere and pane switches
    // still commit.
    if (e.relatedTarget && e.relatedTarget.closest("button")) return;
    const add = e.target.closest("[data-rules-chip-add]");
    if (add) return rulesChipAddCommit(add.dataset.rulesChipAdd, add);
    const rxadd = e.target.closest("[data-rules-rx-add]");
    if (rxadd) return rulesRxAddCommit();
  });
}

// Which Config pane is active. The rail switches this; render()
// re-runs renderConfig, which reads it fresh from this module var.
let configPane = "rules";

async function renderConfig(seq) {
  setFixed(true);
  const docs = state.docs || [];
  const rail = [
    { pane: "rules", label: "Rules" },
    { pane: "vault", label: "Vault" },
    { pane: "runtimes", label: "Runtimes" },
    { pane: "naming", label: "Naming" },
    { pane: "sync", label: "Sync" },
  ];
  const refItems = [
    ...docs.map((d) => ({ pane: "doc:" + d.name, label: d.name })),
    { pane: "loomjson", label: "loom.json" },
  ];
  const navHtml =
    rail
      .map(
        (r) =>
          `<a data-pane="${esc(r.pane)}"${configPane === r.pane ? ' class="on"' : ""}>${esc(r.label)}${r.count != null ? ` <span class="tiny">${r.count}</span>` : ""}</a>`,
      )
      .join("") +
    `<div class="sep"></div><div class="railref">Reference</div>` +
    refItems
      .map(
        (r) =>
          `<a data-pane="${esc(r.pane)}"${configPane === r.pane ? ' class="on"' : ""}>${esc(r.label)}</a>`,
      )
      .join("");
  navStop();
  app().innerHTML = `<div class="configlayout">
          <nav class="setnav cfgrail" id="cfg-nav">${navHtml}</nav>
          <div class="cfgmain" id="cfg-main">
            <div class="cfgcol">
              <h1>Config</h1>
              <p class="rvsub">How this vault is set up: the rules it enforces on every skill, and where it projects them. Pick a section.</p>
              <div id="cfg-pane"></div>
            </div>
          </div>`;
  document
    .querySelectorAll("#cfg-nav a")
    .forEach((a) =>
      a.addEventListener("click", () => switchConfigPane(a.dataset.pane)),
    );
  await fillConfigPane(seq);
}
// Switch config sections without re-rendering the whole view: only the
// content pane (#cfg-pane) is refilled and the nav's active state flips.
// Re-rendering the entire layout (go("config")) flashed the whole box.
function switchConfigPane(pane) {
  if (!pane || configPane === pane) return;
  configPane = pane;
  document
    .querySelectorAll("#cfg-nav a")
    .forEach((x) => x.classList.toggle("on", x.dataset.pane === pane));
  // Switching sections (incl. reference ↔ reference) starts at the top.
  document.getElementById("cfg-main")?.scrollTo(0, 0);
  fillConfigPane(++navSeq);
}
// Reference / loom.json panes carry a Document | History toggle in their
// header (same pattern as the skill detail's Rendered / Source), so the
// git history reuses the pane instead of a permanent extra column.
let docView = "doc";
let curDoc = null;
function docHistoryHtml(commits) {
  if (!commits.length)
    return `<div class="empty" style="margin:20px 24px">No history yet.</div>`;
  return `<div class="dochistv">${commits
    .map(
      (c) =>
        `<div class="dcommit" data-dochash="${esc(c.hash)}"><div class="dctop"><span class="s">${esc(c.subject)}</span><span class="d">${esc(fmtLong(c.date))} · <span class="seewhat">See what changed</span></span></div><div class="dcdiff" hidden></div></div>`,
    )
    .join("")}</div>`;
}
// Render the current reference/loom.json pane (header + Document|History
// toggle + body). No refetch on toggle: content + commits cached in curDoc.
function renderDocPane(p) {
  const d = curDoc;
  if (!d) return;
  const rev = d.commits.length
    ? `<span class="docrev">${d.commits.length} revision${d.commits.length === 1 ? "" : "s"} · last changed ${esc(fmtLong(d.commits[0].date))}</span>`
    : "";
  // Same markup as the skill detail's Rendered/Source toggle (b = active,
  // span = inactive) so it shares the .seg style exactly.
  const segItem = (v, label) =>
    docView === v
      ? `<b data-dview="${v}">${label}</b>`
      : `<span data-dview="${v}">${label}</span>`;
  const seg = d.commits.length
    ? `<span class="seg" id="docseg">${segItem("doc", "Document")}${segItem("hist", "History")}</span>`
    : "";
  const body = docView === "hist" ? docHistoryHtml(d.commits) : d.bodyHtml;
  p.innerHTML = `<div class="panel"><div class="panel-h"><div class="ph-top"><h2>${esc(d.name)} <span class="badge off" style="margin-left:8px">read only</span></h2>${rev}${seg}</div>${d.subtitle}</div><div id="doc-body">${body}</div></div>`;
  if (docView !== "hist") mountMermaid(document.getElementById("doc-body"));
  const segEl = document.getElementById("docseg");
  if (segEl)
    segEl.onclick = (e) => {
      const b = e.target.closest("[data-dview]");
      if (!b || b.dataset.dview === docView) return;
      docView = b.dataset.dview;
      renderDocPane(p);
    };
  if (docView === "hist") wireDocHistory();
}
function wireDocHistory() {
  const box = document.getElementById("doc-body");
  if (!box) return;
  box.onclick = async (e) => {
    const c = e.target.closest(".dcommit");
    if (!c) return;
    const diffBox = c.querySelector(".dcdiff");
    if (!diffBox.hidden) {
      diffBox.hidden = true;
      diffBox.innerHTML = "";
      return;
    }
    const rr = await api(
      `/api/doc-commit?name=${encodeURIComponent(curDoc.name)}&hash=${encodeURIComponent(c.dataset.dochash)}`,
    );
    if (!rr.ok) return toast(rr.data.error || "cannot load commit");
    box.querySelectorAll(".dcdiff").forEach((d) => {
      d.hidden = true;
      d.innerHTML = "";
    });
    diffBox.innerHTML = `<pre class="plain">${colorDiff(rr.data.diff)}</pre>`;
    diffBox.hidden = false;
  };
}

/* ---------- config: pane fill ---------- */
// Fills #cfg-pane for the active configPane. The reference-doc and
// loom.json branches fetch async and guard on navCurrent so a stale
// fetch never overwrites a newer pane switch. The wiring panes
// (vault/runtimes/naming/sync) render synchronously; their controls
// ([data-consumer], [data-inplace], [data-runtimepreset],
// [data-runtimeadd], [data-namedel], [data-nameadd], [data-remote])
// are handled by the single delegated click listener bound on
// document near the bottom of the file, not per-render. The
// wire*Pane() calls below are named hooks kept for parity across
// panes, not actual binding sites.
async function fillConfigPane(seq) {
  const p = $("#cfg-pane");
  if (!p) return;
  // A reference doc / loom.json switches to its Document view on entry.
  if (configPane.startsWith("doc:") || configPane === "loomjson")
    docView = "doc";
  if (configPane.startsWith("doc:")) {
    const name = configPane.slice(4);
    const [dr, hr] = await Promise.all([
      api(`/api/doc?name=${encodeURIComponent(name)}`),
      api(`/api/doc-history?name=${encodeURIComponent(name)}`),
    ]);
    if (!navCurrent(seq)) return;
    const content = dr.ok ? dr.data.content : "(could not load this document)";
    const ext = name.split(".").pop().toLowerCase();
    const bodyHtml = name.toLowerCase().endsWith(".md")
      ? `<article class="md doc">${renderMd(content, false)}</article>`
      : `<pre class="code">${highlight(content, LANG_BY_EXT[ext])}</pre>`;
    curDoc = {
      name,
      subtitle: "",
      bodyHtml,
      commits: hr.data.versioned ? hr.data.commits || [] : [],
    };
    renderDocPane(p);
    return;
  }
  if (configPane === "loomjson") {
    const [dr, hr] = await Promise.all([
      api("/api/loom-json"),
      api("/api/doc-history?name=loom.json"),
    ]);
    if (!navCurrent(seq)) return;
    const content = dr.ok ? dr.data.content : "(could not read loom.json)";
    curDoc = {
      name: "loom.json",
      subtitle: `<p>The full config, as it sits at the vault root. Edit rules in the Rules pane, move the vault and runtimes from the command line.</p>`,
      bodyHtml: `<pre class="code">${highlight(content, "json")}</pre>`,
      commits: hr.data.versioned ? hr.data.commits || [] : [],
    };
    renderDocPane(p);
    return;
  }
  if (configPane === "vault") {
    p.innerHTML = renderVaultPane();
    return;
  }
  if (configPane === "runtimes") {
    p.innerHTML = renderRuntimesPane();
    wireRuntimesPane();
    return;
  }
  if (configPane === "naming") {
    p.innerHTML = renderNamingPane();
    wireNamingPane();
    return;
  }
  if (configPane === "sync") {
    p.innerHTML = renderSyncPane();
    wireSyncPane();
    return;
  }
  // rules (default): the editable form (renderRulesForm() + its
  // delegated listeners, wired once per #cfg-pane node).
  p.innerHTML = renderRulesForm();
  wireRulesPane();
}

/* ---------- config: vault pane ---------- */
function renderVaultPane() {
  const versioned = sync && sync.versioned;
  return `<div class="panel">
          <div class="panel-h"><h2>Vault</h2><p>The one canonical copy every runtime links back to. Move it from the command line; the config follows.</p></div>
          <div class="srow"><div><div class="lbl">Location</div><div class="subv">Where the canonical skills live.</div></div><div class="val"><span class="path">${esc(state.vaultDir)}</span></div></div>
          <div class="srow"><div><div class="lbl">Version control</div><div class="subv">Git tracks every edit and powers multi-machine sync.</div></div><div class="val">${versioned ? `<span class="badge ok">${CHECK}Versioned</span>` : `<span class="badge off">Not versioned</span>`}</div></div>
        </div>`;
}

/* ---------- config: runtimes pane ---------- */
// One list, ordered by name — configured runtimes and detected presets
// interleaved, regardless of on/off/added state.
function renderRuntimesPane() {
  const rtRows = [
    ...Object.entries(state.consumers).map(([name, value]) => ({
      name,
      preset: false,
      value,
    })),
    ...(state.presets || []).map((pr) => ({
      name: pr.name,
      preset: true,
      path: pr.path,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  return `<div class="panel">
          <div class="panel-h"><h2>Runtimes</h2><p>Where skill-loom projects your skills into each runtime. Turn one off to stop linking into it.</p></div>
          ${rtRows
            .map((rt) => {
              if (rt.preset) {
                return `<div class="srow"><div><div class="lbl">${esc(rtName(rt.name))} <span class="badge off" style="margin-left:6px">detected</span></div><div class="subv"><span class="path">${esc(rt.path)}</span></div></div><div class="val"><button class="btn" data-runtimepreset="${esc(rt.name)}" data-path="${esc(rt.path)}">Add</button></div></div>`;
              }
              const p = rt.value;
              const inplace =
                p && typeof p === "object" && p.mode === "in-place";
              if (inplace) {
                const note =
                  (p && p.note) ||
                  "served in place — read directly from the vault";
                // With a servedVia config the toggle is live: it edits that
                // array (activate/deactivate). Without it, it is informational.
                if (p && p.servedVia) {
                  const active = (state.matrix || []).some(
                    (m) => m.consumer === rt.name && m.state === "served",
                  );
                  const tip = active
                    ? "served — click to deactivate (edits the runtime config; restart to apply)"
                    : "inactive — click to activate";
                  return `<div class="srow"><div><div class="lbl">${esc(rtName(rt.name))}</div><div class="subv"><span class="path">${esc(note)}</span></div></div><div class="val"><button class="switch${active ? " on" : ""}" data-inplace="${esc(rt.name)}" title="${tip}"></button></div></div>`;
                }
                return `<div class="srow"><div><div class="lbl">${esc(rtName(rt.name))}</div><div class="subv"><span class="path">${esc(note)}</span></div></div><div class="val"><button class="switch on" disabled title="served in place — no link to toggle"></button></div></div>`;
              }
              const loc = typeof p === "string" ? p : (p && p.path) || "";
              const links = (state.matrix || []).filter(
                (m) =>
                  m.consumer === rt.name &&
                  // Overridden pairs are out of this runtime's count: a
                  // runtime that keeps one skill of its own would otherwise
                  // read "60 of 61" and never turn on, which is a permanent
                  // partial for a state that is finished.
                  m.state !== "external" &&
                  m.state !== "disabled",
              );
              const linked = links.filter((m) => m.state === "linked").length;
              // on = fully linked; a partial runtime reads as off, and the
              // next click links the missing skills instead of tearing
              // everything down.
              const full = links.length > 0 && linked === links.length;
              const hint = full
                ? ""
                : linked > 0
                  ? " — turn on to link the rest"
                  : "";
              return `<div class="srow"><div><div class="lbl">${esc(rtName(rt.name))}</div><div class="subv"><span class="path">${esc(loc)}</span></div></div><div class="val"><button class="switch${full ? " on" : ""}" data-consumer="${esc(rt.name)}" title="${linked} of ${links.length} skills linked${hint}"></button></div></div>`;
            })
            .join("")}
          <div class="addrow"><button class="btn" data-runtimeadd="1">+ Add a runtime</button></div>
        </div>`;
}
function wireRuntimesPane() {
  // no-op: [data-consumer]/[data-inplace]/[data-runtimepreset]/
  // [data-runtimeadd] are handled by the global delegated click
  // listener (see fillConfigPane's comment above).
}

/* ---------- config: naming pane ---------- */
function renderNamingPane() {
  return `<div class="panel">
          <div class="panel-h"><h2>Naming</h2><p>Custom word casing for titles and labels, stored in loom.json. Overrides the built-in acronym and brand dictionaries.</p></div>
          ${Object.entries(state.customNames || {})
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(
              ([w, c]) =>
                `<div class="srow"><div><div class="lbl"><span class="path">${esc(w)}</span></div><div class="subv">shown as <b>${esc(c)}</b></div></div><div class="val"><button class="btn" data-namedel="${esc(w)}">Remove</button></div></div>`,
            )
            .join("")}
          <div class="addrow"><button class="btn" data-nameadd="1">+ Add a word</button></div>
        </div>`;
}
function wireNamingPane() {
  // no-op: [data-nameadd]/[data-namedel] are handled by the global
  // delegated click listener (see fillConfigPane's comment above).
}

/* ---------- config: sync pane ---------- */
function renderSyncPane() {
  return `<div class="panel">
          <div class="panel-h"><h2>Sync</h2><p>Push the vault to a private git remote to use it on more than one machine.</p></div>
          <div class="srow"><div><div class="lbl">Remote</div><div class="subv">Where Sync pushes and pulls.</div></div><div class="val">${sync && sync.remote ? `<span class="path">${esc(sync.remote)}</span>` : `<span class="subv" style="margin:0">none</span>`}<button class="btn" data-remote="1">Change</button></div></div>
        </div>`;
}
function wireSyncPane() {
  // no-op: [data-remote] is handled by the global delegated click
  // listener (see fillConfigPane's comment above).
}

/* ---------- archived ---------- */
// Archived skills as library cards: fill the fields libCard reads
// (modified/status/sync) so the archive renders exactly like My skills.
// Archived skills as library cards: the status column reads the real
// frontmatter status (from the server), not the archived state — that is
// shown by the Archived badge and the archive view itself.
function archivedCards() {
  // No fabricated link or sync state: an archived skill is served by no
  // runtime, and the archive carries no git state of its own. The views that
  // showed those two columns drop them in archived mode instead of filling
  // them with a default that reads as a measurement.
  return (state.archived || []).map((x) => ({
    ...x,
    modified: x.date || "",
    status: x.status || "active",
  }));
}
// Archive is just the library in archived mode — same rail, table, grid,
// search — so it renders through renderLibrary, not a separate view.
function renderArchived() {
  setLibArchived(true);
  renderLibrary();
}

/* ---------- empty / first-run ---------- */
function renderEmpty() {
  setFixed(false);
  app().innerHTML = `<main class="emptyview">
          <section class="hero">
            <span class="mark"><svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M4 7l8-4 8 4-8 4-8-4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 12l8 4 8-4M4 17l8 4 8-4" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></span>
            <h1>Your vault is empty</h1>
            <p>skill-loom keeps one canonical, git-versioned copy of every agent skill, and links it into every runtime. No more copies drifting out of sync. Start with one skill.</p>
            <div class="heroactions"><button class="btn primary" data-go="new">Create your first skill</button></div>
          </section>
          <section class="steps">
            <div class="step"><span class="no">01</span><h3>Write it once</h3><p>One folder in the vault holds the skill and its SKILL.md. That folder is the single source of truth.</p></div>
            <div class="step"><span class="no">02</span><h3>Linked everywhere</h3><p>skill-loom symlinks it into every runtime you use. Edit once, every agent sees the change.</p></div>
            <div class="step"><span class="no">03</span><h3>Versioned &amp; synced</h3><p>Git tracks every edit your agents make. Sync pushes the vault to your other machines.</p></div>
          </section>
        </main>`;
}

/* ---------- lifecycle actions ---------- */

// A skill folder as one file: everything under it, SKILL.md and references and
// scripts alike, zipped by the server that already has the vault open. The
// vault stays where it is — this is a copy for somewhere that does not have
// it, an attachment or a hand-off, not a step in a workflow.
//
// A plain navigation rather than fetch + Blob: the response carries
// content-disposition, so the browser saves the file and the page never moves.
// The cost is that a failure arrives as the server's JSON in a tab instead of
// a toast, which for a local dashboard reading its own vault is the honest
// trade for not holding a second copy of the archive in memory.
function doExport(names) {
  if (!names.length) return;
  const qs = names.map((n) => `name=${encodeURIComponent(n)}`).join("&");
  window.location.assign(`/api/export?${qs}`);
  toast(
    names.length === 1
      ? `Exporting ${names[0]}…`
      : `Exporting ${names.length} skills…`,
  );
}

/* ---------- bulk actions + context menu ---------- */
// Runs a bulk endpoint: dry-run, confirm the plan, apply, reload. `names` is a
// snapshot of the current selection. Clears the selection on success.
async function bulkAction(route, extra, title) {
  const names = [...libSel];
  if (!names.length) return;
  const dry = await api(route, { names, ...extra, apply: false });
  if (!dry.ok) return toast(dry.data.message || dry.data.error);
  if (!dry.data.actions || !dry.data.actions.length)
    return toast("Nothing to change.");
  if (!(await confirmActions(title, dry.data.actions))) return;
  const wet = await api(route, { names, ...extra, apply: true });
  toast(wet.data.message || wet.data.error);
  libSelClear();
  await loadState();
  go("skills");
}
function ctxClose() {
  document.getElementById("skillctx")?.remove();
  document.removeEventListener("click", ctxClose);
  document.removeEventListener("scroll", ctxClose, true);
}
function ctxItems() {
  const n = libSel.size;
  const head = n === 1 ? esc([...libSel][0]) : `${n} skills`;
  // Archive view: only Open (single) + Restore are valid — setFieldOp/migrateOp
  // resolve the live vault path, not .archive/.
  if (libArchived) {
    return (
      `<div class="ctxhd">${head}</div>` +
      (n === 1 ? `<button class="ctxitem" data-ctx="open">Open</button>` : "") +
      // Reading is what the archive is for, and taking a copy is reading.
      `<button class="ctxitem" data-ctx="export">Export</button>` +
      `<button class="ctxitem" data-ctx="restore">Restore</button>`
    );
  }
  const sub = (label, kind, opts) =>
    `<div class="ctxitem has-sub">${label}<span class="ctxarr">›</span><div class="ctxsub">${opts
      .map(
        (o) =>
          `<button class="ctxitem" data-ctx="${kind}" data-val="${esc(o.v)}">${esc(o.label)}</button>`,
      )
      .join("")}</div></div>`;
  const statusOpts = STATUS_ORDER.map((v) => ({
    v,
    label: statusLabel(v),
  }));
  // One submenu per declared axis. Prefixed "tax:" in data-ctx so it can't
  // collide with the fixed kinds (status/rename/archive/restore) below —
  // bulkTaxonomyOp (src/ops.ts) already validates any declared axis id.
  const axisSubs = axisList()
    .map((a) => {
      const vals = (
        a.values && a.values.length ? a.values : axisValues(a.id)
      ).map((v) => ({ v, label: humanTax(v) }));
      const label = `Set ${esc(axisLabel(a.id))}`;
      return vals.length
        ? sub(label, `tax:${a.id}`, vals)
        : `<div class="ctxitem disabled">${label} (none defined)</div>`;
    })
    .join("");
  return (
    `<div class="ctxhd">${head}</div>` +
    (n === 1 ? `<button class="ctxitem" data-ctx="open">Open</button>` : "") +
    sub("Set status", "status", statusOpts) +
    axisSubs +
    `<button class="ctxitem" data-ctx="export">Export</button>` +
    `<button class="ctxitem" data-ctx="archive">Archive</button>`
  );
}
function ctxOpen(x, y) {
  ctxClose();
  const m = document.createElement("div");
  m.id = "skillctx";
  m.className = "ctxmenu";
  m.innerHTML = ctxItems();
  document.body.appendChild(m);
  // keep the menu inside the viewport
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
  m.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
  m.addEventListener("click", onCtxClick);
  // close on the next outside click / any scroll
  setTimeout(() => {
    document.addEventListener("click", ctxClose);
    document.addEventListener("scroll", ctxClose, true);
  }, 0);
}
async function onCtxClick(e) {
  const b = e.target.closest("[data-ctx]");
  if (!b || b.classList.contains("disabled")) return;
  e.stopPropagation();
  const kind = b.dataset.ctx;
  const val = b.dataset.val;
  ctxClose();
  if (kind === "open") return go("detail", [...libSel][0]);
  if (kind === "export") return doExport([...libSel]);
  if (kind === "status")
    return bulkAction(
      "/api/bulk/status",
      { status: val },
      `Set status to "${statusLabel(val)}"?`,
    );
  if (kind.startsWith("tax:")) {
    const axisId = kind.slice(4);
    return bulkAction(
      "/api/bulk/taxonomy",
      { field: axisId, value: val },
      `Set ${axisLabel(axisId)} to "${humanTax(val)}"?`,
    );
  }
  if (kind === "archive")
    return bulkAction(
      "/api/bulk/archive",
      {},
      `Archive ${libSel.size} skill(s)?`,
    );
  if (kind === "restore")
    return bulkAction(
      "/api/bulk/restore",
      {},
      `Restore ${libSel.size} skill(s)?`,
    );
}

/* ---------- markdown (escaped-first minimal renderer) ---------- */
/* ── self-contained syntax highlighter (see highlighter.js) ── */
const LANG_BY_EXT = {
  py: "python",
  json: "json",
  // One JSON object per line: the JSON tokenizer colours each of them, which
  // is the whole point of opening a run log in the viewer.
  jsonl: "json",
  ndjson: "json",
  jsonc: "json",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  sh: "bash",
  bash: "bash",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  // PHP has no dedicated tokenizer; the JS one is close enough (C-style
  // comments, strings, numbers, shared keywords) to color it usefully.
  php: "javascript",
  html: "html",
  htm: "html",
  css: "css",
  toml: "toml",
  xml: "xml",
};

const LANG_BY_FENCE = {
  python: "python",
  py: "python",
  json: "json",
  javascript: "javascript",
  js: "javascript",
  typescript: "typescript",
  ts: "typescript",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  console: "bash",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  css: "css",
  toml: "toml",
  xml: "xml",
  markdown: "markdown",
  md: "markdown",
};

function hlEsc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function kwRe(words) {
  return new RegExp("\\b(?:" + words.join("|") + ")\\b");
}

// Builds a single combined regex out of an ordered list of {type, re} rules.
// Earlier rules win at a given start position (JS alternation tries
// alternatives in order, not by length), so comments/strings must precede
// keyword/number/identifier rules. Each rule is wrapped in exactly one
// capturing group so we can recover which rule matched without any rule's
// own regex using capturing groups internally (only (?:...) / lookaheads).
function buildTokenizer(rules) {
  let combined;
  try {
    combined = new RegExp(
      rules.map((r) => "(" + r.re.source + ")").join("|"),
      "gm",
    );
  } catch (e) {
    return null;
  }
  return function (code) {
    let out = "";
    let last = 0;
    let m;
    combined.lastIndex = 0;
    while ((m = combined.exec(code)) !== null) {
      if (m.index > last) out += hlEsc(code.slice(last, m.index));
      if (m[0].length === 0) {
        combined.lastIndex = m.index + 1;
        last = m.index;
        continue;
      }
      let type = null;
      for (let i = 0; i < rules.length; i++) {
        if (m[i + 1] !== undefined) {
          type = rules[i].type;
          break;
        }
      }
      out += type
        ? '<span class="tok-' + type + '">' + hlEsc(m[0]) + "</span>"
        : hlEsc(m[0]);
      last = m.index + m[0].length;
    }
    if (last < code.length) out += hlEsc(code.slice(last));
    return out;
  };
}

const PYTHON_RULES = [
  { type: "com", re: /#[^\n]*/ },
  { type: "str", re: /"""[\s\S]*?"""|'''[\s\S]*?'''/ },
  { type: "str", re: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/ },
  { type: "fn", re: /@[A-Za-z_][\w.]*/ },
  {
    type: "num",
    re: /\b0[xX][0-9a-fA-F]+\b|\b\d+\.\d+(?:[eE][+-]?\d+)?\b|\b\d+[jJ]?\b/,
  },
  { type: "bool", re: /\b(?:None|True|False)\b/ },
  {
    type: "kw",
    re: kwRe([
      "def",
      "class",
      "return",
      "if",
      "elif",
      "else",
      "for",
      "while",
      "import",
      "from",
      "as",
      "with",
      "try",
      "except",
      "finally",
      "raise",
      "yield",
      "lambda",
      "pass",
      "break",
      "continue",
      "global",
      "nonlocal",
      "in",
      "is",
      "not",
      "and",
      "or",
      "async",
      "await",
    ]),
  },
  { type: "fn", re: /\b[A-Za-z_]\w*(?=\s*\()/ },
];

const JS_KEYWORDS = [
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "class",
  "new",
  "import",
  "export",
  "from",
  "default",
  "async",
  "await",
  "try",
  "catch",
  "finally",
  "throw",
  "typeof",
  "instanceof",
  "of",
  "in",
  "this",
  "switch",
  "case",
  "break",
  "continue",
  "do",
  "delete",
  "void",
  "yield",
  "super",
  "extends",
  "static",
  "get",
  "set",
];
const TS_EXTRA_KEYWORDS = [
  "interface",
  "type",
  "enum",
  "implements",
  "public",
  "private",
  "protected",
  "readonly",
  "namespace",
  "declare",
  "as",
  "satisfies",
  "keyof",
];

function jsLikeRules(extraKeywords) {
  return [
    { type: "com", re: /\/\/[^\n]*/ },
    { type: "com", re: /\/\*[\s\S]*?\*\// },
    { type: "str", re: /`(?:\\.|[^`\\])*`/ },
    { type: "str", re: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/ },
    {
      type: "num",
      re: /\b0[xX][0-9a-fA-F]+\b|\b\d+\.\d+(?:[eE][+-]?\d+)?\b|\.\d+(?:[eE][+-]?\d+)?\b|\b\d+(?:[eE][+-]?\d+)?\b/,
    },
    { type: "bool", re: /\b(?:true|false|null|undefined|NaN)\b/ },
    { type: "kw", re: kwRe(JS_KEYWORDS.concat(extraKeywords || [])) },
    { type: "fn", re: /\b[A-Za-z_$][\w$]*(?=\s*\()/ },
  ];
}

const JAVASCRIPT_RULES = jsLikeRules([]);
const TYPESCRIPT_RULES = jsLikeRules(TS_EXTRA_KEYWORDS);

const JSON_RULES = [
  { type: "prop", re: /"(?:\\.|[^"\\\n])*"(?=\s*:)/ },
  { type: "str", re: /"(?:\\.|[^"\\\n])*"/ },
  { type: "num", re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/ },
  { type: "bool", re: /\b(?:true|false|null)\b/ },
];

const BASH_RULES = [
  { type: "com", re: /#[^\n]*/ },
  { type: "str", re: /"(?:\\.|[^"\\])*"/ },
  { type: "str", re: /'[^']*'/ },
  {
    type: "num",
    re: /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!_-]/,
  },
  {
    type: "kw",
    re: kwRe([
      "if",
      "then",
      "else",
      "elif",
      "fi",
      "for",
      "while",
      "do",
      "done",
      "case",
      "esac",
      "function",
      "in",
      "select",
      "until",
      "time",
    ]),
  },
  { type: "num", re: /\b\d+\b/ },
  { type: "fn", re: /\b[A-Za-z_][\w-]*(?=\s*\(\s*\))/ },
];

const YAML_RULES = [
  { type: "com", re: /#[^\n]*/ },
  {
    type: "prop",
    re: /^[ \t]*(?:-[ \t]+)?[A-Za-z0-9_.\-\/]+(?=\s*:(?:\s|$))/,
  },
  { type: "str", re: /"(?:\\.|[^"\\\n])*"|'(?:[^'\n]|'')*'/ },
  {
    type: "bool",
    re: /\b(?:true|false|True|False|TRUE|FALSE|null|Null|NULL|~)\b/,
  },
  { type: "num", re: /-?\b\d+(?:\.\d+)?\b/ },
];

const TOML_RULES = [
  { type: "com", re: /#[^\n]*/ },
  {
    type: "str",
    re: /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'[^'\n]*'/,
  },
  { type: "kw", re: /^[ \t]*\[\[?[^\]\n]*\]\]?/ },
  { type: "prop", re: /^[ \t]*[A-Za-z0-9_.\-]+(?=\s*=)/ },
  { type: "bool", re: /\b(?:true|false)\b/ },
  { type: "num", re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/ },
];

const CSS_RULES = [
  { type: "com", re: /\/\*[\s\S]*?\*\// },
  { type: "str", re: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/ },
  { type: "kw", re: /@[A-Za-z-]+/ },
  { type: "kw", re: /!important\b/ },
  { type: "prop", re: /[A-Za-z-]+(?=\s*:\s)/ },
  { type: "num", re: /-?\b\d+(?:\.\d+)?[a-zA-Z%]{0,4}/ },
];

const HTML_RULES = [
  { type: "com", re: /<!--[\s\S]*?-->/ },
  { type: "tag", re: /<\/?[A-Za-z][\w:.-]*/ },
  { type: "attr", re: /\b[A-Za-z_:][\w:.-]*(?=\s*=)/ },
  { type: "str", re: /"[^"]*"|'[^']*'/ },
];

const MARKDOWN_RULES = [
  { type: "kw", re: /^ {0,3}#{1,6}[ \t].*$/ },
  { type: "str", re: /`[^`\n]*`/ },
];

const TOKENIZERS = {
  python: buildTokenizer(PYTHON_RULES),
  javascript: buildTokenizer(JAVASCRIPT_RULES),
  typescript: buildTokenizer(TYPESCRIPT_RULES),
  json: buildTokenizer(JSON_RULES),
  bash: buildTokenizer(BASH_RULES),
  yaml: buildTokenizer(YAML_RULES),
  toml: buildTokenizer(TOML_RULES),
  css: buildTokenizer(CSS_RULES),
  html: buildTokenizer(HTML_RULES),
  xml: buildTokenizer(HTML_RULES),
  markdown: buildTokenizer(MARKDOWN_RULES),
};

function highlight(code, lang) {
  let src;
  try {
    src = code == null ? "" : String(code);
  } catch (e) {
    return "";
  }
  try {
    const fn = lang ? TOKENIZERS[lang] : null;
    if (!fn) return hlEsc(src);
    return fn(src);
  } catch (e) {
    try {
      return hlEsc(src);
    } catch (e2) {
      return "";
    }
  }
}

// VSCode-style colour chip: prepend a swatch to any CSS colour inside inline
// code — hex (#rgb … #rrggbbaa) and function-form (rgb/rgba, hsl/hsla, oklch,
// oklab, lab, lch). The chip's background IS the value, so the browser renders
// it. Runs on already-escaped text; the function-form char class excludes
// quotes and angle brackets so the value can't break out of the style attribute.
function colorSw(s) {
  return s
    .replace(
      /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g,
      (h) => `<span class="hexsw" style="background:${h}"></span>${h}`,
    )
    .replace(
      /\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\([0-9a-zA-Z.,%/ \t-]*\)/gi,
      (c) => `<span class="hexsw" style="background:${c}"></span>${c}`,
    );
}
// Parse a frontmatter block into ordered [key, value] rows. value is a
// string, a {list:[...]} (block "- " or inline comma list), or a nested
// {obj:[[k,v]...]}. The parser is indent-based and recursive, so arbitrary
// depth (e.g. metadata.lint.forbid-waiver.reason) is preserved, not
// flattened.
function parseFrontmatter(fm) {
  const lines = (fm || "").split("\n");
  const block = (start, indent) => {
    const rows = [];
    let i = start;
    while (i < lines.length) {
      const raw = lines[i];
      if (!raw.trim() || /^\s*#/.test(raw)) {
        i++;
        continue;
      }
      const ind = raw.length - raw.trimStart().length;
      if (ind < indent) break;
      if (ind > indent) {
        i++;
        continue;
      }
      const kv = /^\s*([A-Za-z0-9_.\/-]+):\s?(.*)$/.exec(raw);
      if (!kv) {
        i++;
        continue;
      }
      const key = kv[1];
      i++;
      const val = kv[2];
      // Flow-style array [ ... ] — inline (key: [a, b]) or spanning several
      // lines under an empty value (key:\n  [\n a,\n b,\n ]). YAML allows both;
      // gather through the closing "]" and split on commas into a list.
      let flowFrom = -1;
      const isFlowInline = val.startsWith("[");
      if (isFlowInline) {
        flowFrom = i;
      } else if (val === "") {
        let j = i;
        while (j < lines.length && (!lines[j].trim() || /^\s*#/.test(lines[j])))
          j++;
        if (j < lines.length && lines[j].trimStart().startsWith("["))
          flowFrom = j;
      }
      if (flowFrom >= 0) {
        let buf = isFlowInline ? val : lines[flowFrom];
        let k = isFlowInline ? i : flowFrom + 1;
        while (!buf.includes("]") && k < lines.length) {
          buf += " " + lines[k];
          k++;
        }
        const inner = buf.slice(buf.indexOf("[") + 1, buf.lastIndexOf("]"));
        const items = inner
          .split(",")
          .map((x) => x.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, ""))
          .filter(Boolean);
        rows.push([key, { list: items }]);
        i = k;
        continue;
      }
      if (kv[2] === "") {
        // look ahead past blanks/comments for a nested block or list
        let j = i;
        while (j < lines.length && (!lines[j].trim() || /^\s*#/.test(lines[j])))
          j++;
        const nind =
          j < lines.length ? lines[j].length - lines[j].trimStart().length : -1;
        if (nind > indent && /^\s*-\s+/.test(lines[j])) {
          const items = [];
          i = j;
          while (i < lines.length) {
            const lm = /^(\s*)-\s+(.*)$/.exec(lines[i]);
            if (!lm || lm[1].length !== nind) break;
            items.push(
              lm[2].trim().replace(/^"|"$/g, "").replace(/^'|'$/g, ""),
            );
            i++;
          }
          rows.push([key, { list: items }]);
          continue;
        }
        if (nind > indent) {
          const sub = block(j, nind);
          rows.push([key, { obj: sub.rows }]);
          i = sub.i;
          continue;
        }
      }
      rows.push([key, kv[2].replace(/^"|"$/g, "").replace(/^'|'$/g, "")]);
    }
    return { rows, i };
  };
  return block(0, 0).rows;
}
// Frontmatter keys whose value is a list (rendered as chips), whether the
// source used an inline comma list or a block "- " list.
const FM_LIST_KEYS = new Set([
  "tools",
  "disallowedTools",
  "allowedTools",
  "allowedDomains",
  "allowedLayers",
  "requireTaxonomy",
  "requireSections",
  "tags",
  "sources",
  "forbidBodyPatterns",
]);
const FM_URL = (v) => typeof v === "string" && /^https?:\/\//.test(v);
// Wrap bare http(s) URLs in already-escaped/inlined text as links —
// including inside inline `<code>` (a reference URL in backticks should
// still be clickable). Existing <a> anchors are stashed first so their
// href/text URLs are never double-linkified. Trailing sentence punctuation
// stays outside the link.
function linkifyBareUrls(s) {
  const anchors = [];
  const stashed = s.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, (m) => {
    anchors.push(m);
    return `\u0000${anchors.length - 1}\u0000`;
  });
  const linked = stashed.replace(/https?:\/\/[^\s<>"'`)\]]+/g, (u) => {
    const tail = (/[.,;:!?]+$/.exec(u) || [""])[0];
    const core = tail ? u.slice(0, -tail.length) : u;
    return `<a href="${core}" rel="noopener" target="_blank">${core}</a>${tail}`;
  });
  return linked.replace(/\u0000(\d+)\u0000/g, (_, i) => anchors[+i]);
}
// Single recursive frontmatter value renderer, shared by the frontmatter
// card AND the skill detail rail, so nested objects and lists render
// identically in both places. Nested objects indent recursively; lists
// become chips; model/description/URLs keep their treatments.
function fmValHtml(key, val) {
  if (val && typeof val === "object" && val.obj)
    return `<div class="fmsub">${val.obj
      .map(([k, v]) => {
        // A nested object stacks (key on its own line, block indented
        // below) so deep trees never cascade the value into a sliver.
        const nested = v && typeof v === "object" && v.obj;
        return nested
          ? `<div class="fmsubrow nested"><span class="fmk">${esc(k)}</span>${fmValHtml(k, v)}</div>`
          : `<div class="fmsubrow"><span class="fmk">${esc(k)}</span><span class="fmv">${fmValHtml(k, v)}</span></div>`;
      })
      .join("")}</div>`;
  let list = val && typeof val === "object" && val.list ? val.list : null;
  if (
    !list &&
    typeof val === "string" &&
    FM_LIST_KEYS.has(key) &&
    val.includes(",")
  )
    list = val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (list) {
    const cls = key === "disallowedTools" ? " deny" : "";
    // A single-item list reads as plain bracketed text (`[value]`), not a
    // lone chip; two or more render as chips side by side.
    if (list.length === 1) {
      const v = list[0];
      const inner = FM_URL(v)
        ? `<a class="fmlink" href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>`
        : esc(v);
      return `<span class="fmvmono">[${inner}]</span>`;
    }
    return list
      .map((v) =>
        FM_URL(v)
          ? `<a class="chip${cls} fmlink" href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>`
          : `<span class="chip${cls}">${esc(v)}</span>`,
      )
      .join("");
  }
  if (key === "model") return `<span class="chip model">${esc(val)}</span>`;
  if (key === "description") return `<span class="fmvdesc">${esc(val)}</span>`;
  if (FM_URL(val))
    return `<a class="fmvmono fmlink" href="${esc(val)}" target="_blank" rel="noopener">${esc(val)}</a>`;
  return `<span class="fmvmono">${esc(val ?? "")}</span>`;
}
// A secondary file's frontmatter as a compact metadata card. Generic:
// works for agent files and any other frontmatter schema.
function renderFrontmatterCard(fm, fmFile) {
  const rows = parseFrontmatter(fm);
  // On the main SKILL.md the name/description already sit in the detail
  // header, so drop them here (this card is only used for secondary files).
  const skipDup = fmFile === "SKILL.md";
  const shown = rows.filter(
    ([k]) => !(skipDup && (k === "name" || k === "description")),
  );
  if (!shown.length) return "";
  const body = shown
    .map(
      ([k, v]) =>
        `<div class="fmrow"><span class="fmk">${esc(k)}</span><span class="fmv">${fmValHtml(k, v)}</span></div>`,
    )
    .join("");
  const file = fmFile ? `<span class="ffile">${esc(fmFile)}</span>` : "";
  return `<div class="fmcard"><div class="fh"><span class="ft">Frontmatter</span>${file}</div>${body}</div>`;
}
// Taxonomy chips + lifecycle status for the skill detail header — the
// library already trains the eye to read these, so no frontmatter card.
function detMetaHtml(s) {
  const out = axisList()
    .filter((a) => s[a.id])
    .map((a) => taxChip(a.id, s[a.id]));
  out.push(statusBadge(s.status || "active", true));
  return `<div class="detmeta">${out.join("")}</div>`;
}
// A metadata list value → clean chip strings. Handles a parsed block list,
// an inline YAML array kept as a "[a, b]" string, and a bare comma string.
function metaListValues(val) {
  if (val && typeof val === "object" && val.list) return val.list;
  let s = String(val ?? "").trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  return s
    .split(",")
    .map((x) => x.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}
// Non-taxonomy frontmatter (the metadata: object), shown below the
// description in the main column. `sources` render as bare chips (no label);
// a lint waiver renders as a soft note carrying its reason; anything else
// falls back to a small labelled line. No divider, no "Metadata" header — it
// reads as part of the document. name/description/status and every declared
// axis already live in the header and taxonomy chips.
function skillMetaHtml(fm) {
  if (!fm) return "";
  const HIDE = new Set([
    "name",
    "description",
    "status",
    "icon",
    "icon-color",
    ...axisList().map((a) => a.id),
  ]);
  const rows = parseFrontmatter(fm).filter(([k]) => !HIDE.has(k));
  if (!rows.length) return "";
  const leaves = [];
  const walk = (trail, key, val) => {
    if (val && typeof val === "object" && val.obj)
      val.obj.forEach(([k, v]) => walk([...trail, key], k, v));
    else leaves.push({ trail: [...trail, key], val });
  };
  rows.forEach(([k, v]) =>
    k === "metadata" && v && typeof v === "object" && v.obj
      ? v.obj.forEach(([ck, cv]) => walk([], ck, cv))
      : walk([], k, v),
  );
  const parts = leaves.map(({ trail, val }) => {
    // OpenClaw runtime hints: drop the decorative emoji (the skill's own
    // tile already stands in), and show always-injected as an accent chip
    // when set. Other openclaw.* keys fall through to the generic handling.
    if (trail[0] === "openclaw") {
      const leaf = trail[trail.length - 1];
      if (leaf === "emoji") return "";
      if (leaf === "always")
        return val === true || val === "true"
          ? `<div class="smchips"><span class="injchip">always-injected</span></div>`
          : "";
    }
    // A lint waiver (…-waiver.reason) → a soft note labelled by its kind.
    const waiver = trail.find((t) => /-waiver$/.test(t));
    if (waiver) {
      const label = waiver.charAt(0).toUpperCase() + waiver.slice(1);
      return `<div class="smnote"><span class="smnk">${esc(label)}</span><p class="smnr">${linkifyBareUrls(esc(String(val ?? "")))}</p></div>`;
    }
    const key = trail[trail.length - 1];
    const isList =
      (val && typeof val === "object" && val.list) ||
      FM_LIST_KEYS.has(key) ||
      (typeof val === "string" && val.trim().startsWith("["));
    if (isList)
      return `<div class="smchips">${metaListValues(val)
        .map((v) => `<span class="chip">${esc(v)}</span>`)
        .join("")}</div>`;
    // Fallback: any other custom scalar as a small labelled line.
    return `<div class="smline"><span class="smk">${trail.map(esc).join(" · ")}</span><span class="smv">${linkifyBareUrls(esc(String(val ?? "")))}</span></div>`;
  });
  const body = parts.filter(Boolean).join("");
  if (!body) return ""; // e.g. a skill whose only metadata was a dropped emoji
  return `<section class="skillmeta">${body}</section>`;
}
// GitHub-style heading slug: lowercase, drop punctuation, spaces → hyphens.
// Keeps unicode letters/numbers so accented headings anchor correctly.
// Emoji in vault documents are status markers, not decoration: ⚠️ is a warning,
// 🔴 a red KR, ✅ an allowed destination. Render them with the dashboard's own
// Lucide glyphs, tinted with the state tokens, so a document speaks the same
// visual language as the rest of the UI instead of dropping in colour blobs
// from whatever emoji font the platform happens to ship. Anything not listed
// here falls through to that font unchanged.
//
// Code spans are left alone: inside `foo ⚠️ bar` the character is content.
function emojiIcons(html) {
  const MAP = {
    "⚠": ["triangle-alert", "warn"],
    "❗": ["circle-alert", "warn"],
    "🚨": ["siren", "err"],
    "✅": ["circle-check", "ok"],
    "❌": ["circle-x", "err"],
    "🔴": ["circle", "err", true],
    "🟡": ["circle", "warn", true],
    "🟢": ["circle", "ok", true],
    // Filled and amber, not the outline: ⭐ in vault documents is a rating
    // mark ("★★★★ replicabilità PMI"), and a hollow grey star reads as an
    // empty rating — the opposite of what the author wrote.
    "⭐": ["star", "warn", true],
    "🎯": ["target", "dim"],
    "🤖": ["bot", "dim"],
    "📝": ["pencil", "dim"],
    "🔧": ["wrench", "dim"],
    "📊": ["chart-column", "dim"],
    "💬": ["message-circle", "dim"],
  };
  // U+FE0F (variation selector) follows most of these in real documents.
  const re = new RegExp("(" + Object.keys(MAP).join("|") + ")️?", "g");
  const swap = (s) =>
    s.replace(re, (_, ch) => {
      const [name, state, filled] = MAP[ch];
      return `<span class="gly ${state}"><svg viewBox="0 0 24 24" fill="${
        filled ? "currentColor" : "none"
      }" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconInner(name)}</svg></span>`;
    });
  return html
    .split(/(<code>[\s\S]*?<\/code>)/)
    .map((part, i) => (i % 2 ? part : swap(part)))
    .join("");
}

function slugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
// ---------- Mermaid: lazy-loaded, theme-synced diagram rendering ----------
// The library is vendored at /mermaid.js (a devDependency copied into dist at
// build, not a runtime dep) and pulled in only the first time a rendered doc
// actually holds a mermaid fence. Every failure path — library unreachable,
// diagram unparseable — falls back to the diagram's source, never a blank gap.
let mermaidLib = null;
let mermaidLoading = null;
let mermaidSeq = 0;
function isDarkTheme() {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark") return true;
  if (t === "light") return false;
  return matchMedia("(prefers-color-scheme: dark)").matches;
}
// Resolve app colour tokens to concrete rgb() for the current theme. mermaid
// does colour maths (khroma) that chokes on oklch(), and this browser keeps
// getComputedStyle().color in oklch() — so paint each token on a 1px canvas and
// read the rasterised sRGB bytes back, which are always plain rgb.
function tokenColors(names) {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;left:-9999px;visibility:hidden";
  document.body.appendChild(probe);
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const out = {};
  for (const n of names) {
    probe.style.color = `var(${n})`;
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = "#000";
    cx.fillStyle = getComputedStyle(probe).color;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    out[n] = `rgb(${d[0]} ${d[1]} ${d[2]})`;
  }
  probe.remove();
  return out;
}
// Diagrams are chrome, not a focal point (Restrained): nodes take the app's
// raised surface with a hairline border, edges and text stay in the muted
// tiers, and the brand accent is left out entirely. Colours are resolved per
// theme so a flip re-renders to the right palette.
function mermaidConfig() {
  const c = tokenColors([
    "--panel",
    "--pane",
    "--line",
    "--prose",
    "--fg",
    "--dim",
  ]);
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: {
      darkMode: isDarkTheme(),
      fontFamily: 'Figtree, system-ui, -apple-system, "Segoe UI", sans-serif',
      fontSize: "13px",
      background: "transparent",
      // In this low-contrast neutral system the boxes are read by their border,
      // not their fill (fills sit a step apart at most) — so nodes take a subtle
      // surface with a clearly-visible --dim outline and readable text.
      primaryColor: c["--panel"],
      mainBkg: c["--panel"],
      secondaryColor: c["--pane"],
      tertiaryColor: c["--pane"],
      primaryBorderColor: c["--dim"],
      nodeBorder: c["--dim"],
      clusterBkg: c["--pane"],
      clusterBorder: c["--line"],
      lineColor: c["--dim"],
      primaryTextColor: c["--fg"],
      textColor: c["--prose"],
      titleColor: c["--fg"],
      edgeLabelBackground: c["--pane"],
    },
  };
}
function loadMermaid() {
  if (mermaidLib) return Promise.resolve(mermaidLib);
  if (mermaidLoading) return mermaidLoading;
  mermaidLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/mermaid.js";
    s.onload = () =>
      window.mermaid
        ? resolve((mermaidLib = window.mermaid))
        : reject(new Error("mermaid global missing after load"));
    s.onerror = () => reject(new Error("mermaid.js failed to load"));
    document.head.appendChild(s);
  });
  return mermaidLoading;
}
// Replace a mermaid host (unmounted <pre> or rendered wrap) with its source
// shown as code, plus a one-line reason. The last resort for any failure — the
// reader always keeps the diagram text.
function mermaidFallback(el, reason) {
  const src = decodeURIComponent(el.getAttribute("data-mmd") || "");
  const note = reason
    ? `<div class="mermaid-err">Diagram not rendered — ${esc(reason)}</div>`
    : "";
  const box = document.createElement("div");
  box.innerHTML = `${note}<pre class="code"><code>${highlight(src, null)}</code></pre>`;
  el.replaceWith(box);
}
async function renderOneMermaid(lib, host) {
  const src = decodeURIComponent(host.getAttribute("data-mmd") || "");
  const id = "mmd-" + ++mermaidSeq;
  try {
    const { svg } = await lib.render(id, src);
    const wrap = document.createElement("div");
    wrap.className = "mermaid-wrap";
    wrap.setAttribute("data-mmd", host.getAttribute("data-mmd"));
    wrap.setAttribute("role", "img");
    wrap.title = "Click to enlarge";
    wrap.innerHTML = svg;
    host.replaceWith(wrap);
  } catch (err) {
    // mermaid can leave a measuring node behind in the body on failure.
    document.getElementById("d" + id)?.remove();
    mermaidFallback(host, (err && err.message) || "invalid diagram");
  }
}
// Render every unmounted mermaid block inside `root`. No-op (and no 2.8MB
// fetch) when there are none, keeping the cost off pages without diagrams.
async function mountMermaid(root) {
  if (!root) return;
  const hosts = [...root.querySelectorAll("pre.mermaid[data-mmd]")];
  if (!hosts.length) return;
  let lib;
  try {
    lib = await loadMermaid();
  } catch (err) {
    hosts.forEach((h) =>
      mermaidFallback(h, (err && err.message) || "load failed"),
    );
    return;
  }
  lib.initialize(mermaidConfig());
  for (const h of hosts) await renderOneMermaid(lib, h);
}
// Re-render mounted diagrams after a theme flip: mermaid bakes its palette into
// the SVG at render time, so re-rendering from the retained source is the only
// way to retheme. No-op before the library has ever loaded.
async function restyleMermaid() {
  if (!mermaidLib) return;
  const wraps = [...document.querySelectorAll(".mermaid-wrap[data-mmd]")];
  if (!wraps.length) return;
  mermaidLib.initialize(mermaidConfig());
  for (const w of wraps) {
    const host = document.createElement("pre");
    host.className = "mermaid";
    host.setAttribute("data-mmd", w.getAttribute("data-mmd"));
    w.replaceWith(host);
    await renderOneMermaid(mermaidLib, host);
  }
}
// Click a diagram to enlarge it in a scrollable overlay; click the overlay or
// press Escape to close. Registered once at load.
function openMermaidZoom(wrap) {
  let ov = document.getElementById("mmd-zoom");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "mmd-zoom";
    ov.innerHTML = `<div class="mmd-zoom-inner"></div>`;
    ov.addEventListener("click", (e) => {
      e.stopPropagation();
      ov.classList.remove("on");
    });
    document.body.appendChild(ov);
  }
  const inner = ov.querySelector(".mmd-zoom-inner");
  inner.innerHTML = wrap.innerHTML;
  // mermaid emits width="100%" with no height; in the overlay's shrink-to-fit
  // box that collapses to 0×0 (an empty window). Pin the clone to its viewBox
  // size so it opens at natural resolution and the box scrolls when it's
  // bigger than the screen.
  const svg = inner.querySelector("svg");
  const vb = svg && svg.viewBox && svg.viewBox.baseVal;
  if (vb && vb.width) {
    svg.style.width = Math.ceil(vb.width) + "px";
    svg.style.height = Math.ceil(vb.height) + "px";
    svg.style.maxWidth = "none";
  }
  ov.classList.add("on");
}
document.addEventListener("click", (e) => {
  const w = e.target instanceof Element && e.target.closest(".mermaid-wrap");
  if (w) openMermaidZoom(w);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const ov = document.getElementById("mmd-zoom");
  if (!ov || !ov.classList.contains("on")) return;
  ov.classList.remove("on");
  // This listener is registered before the app's global Escape (which would
  // otherwise leave the detail view), so stopping here keeps Escape scoped to
  // just closing the zoom while it is open.
  e.stopImmediatePropagation();
  e.preventDefault();
});

function renderMd(src, showFm = true, fmFile = "", humanTitle = "") {
  // Per-render slug registry so duplicate headings get -1/-2 suffixes and
  // in-page anchor links resolve to a unique element id.
  const slugSeen = Object.create(null);
  const headingId = (raw) => {
    const base = slugify(raw) || "section";
    let id = base,
      n = 1;
    while (slugSeen[id]) id = `${base}-${n++}`;
    slugSeen[id] = true;
    return id;
  };
  let text = src,
    fm = "";
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (m) {
    fm = m[1];
    text = text.slice(m[0].length);
  }
  const inline = (s) =>
    emojiIcons(
      linkifyBareUrls(
        s
          .replace(/`([^`]+)`/g, (m, c) => "<code>" + colorSw(c) + "</code>")
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
          .replace(/\*([^*]+)\*/g, "<em>$1</em>")
          // Underscore emphasis only at word boundaries, per CommonMark: the
          // vault is full of snake_case identifiers (replaced_by,
          // test_gate_contract.py, lint.protectedTerms) and intra-word
          // underscores must stay literal. A leading backslash escapes it.
          .replace(
            /(^|[^A-Za-z0-9_\\])__([^_\n]+)__(?![A-Za-z0-9_])/g,
            "$1<strong>$2</strong>",
          )
          .replace(
            /(^|[^A-Za-z0-9_\\])_([^_\n]+)_(?![A-Za-z0-9_])/g,
            "$1<em>$2</em>",
          )
          .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, t, u) =>
            u.startsWith("#")
              ? // in-page anchor: scroll within the viewer, never a new tab/reload
                `<a href="${u}" class="docanchor">${t}</a>`
              : /^(https?:\/\/|\.|\/)/.test(u)
                ? `<a href="${u}" rel="noopener" target="_blank">${t}</a>`
                : all,
          ),
      ),
    );
  const lines = esc(text).split("\n");
  const rawLines = text.split("\n");
  let html = fm && showFm ? renderFrontmatterCard(fm, fmFile) : "";
  let inCode = false,
    codeLang = null,
    codeFence = null,
    codeBuf = [],
    firstH1 = true,
    para = [];
  const flushPara = () => {
    if (para.length) {
      html += `<p>${inline(para.join(" "))}</p>`;
      para = [];
    }
  };
  // Cells split on unescaped pipes only: a `\|` inside a cell (typically a
  // pipe within a code span, e.g. `ifconfig \| grep`) is literal content, not
  // a column boundary. Splitting on it shifts every later cell one column
  // right and cuts the code span in half.
  const splitRow = (row) => {
    const c = [];
    let cur = "";
    for (let i = 0; i < row.length; i++) {
      if (row[i] === "\\" && row[i + 1] === "|") {
        cur += "|";
        i++;
      } else if (row[i] === "|") {
        c.push(cur);
        cur = "";
      } else cur += row[i];
    }
    c.push(cur);
    if (c.length && c[0].trim() === "") c.shift();
    if (c.length && c[c.length - 1].trim() === "") c.pop();
    return c.map((x) => x.trim());
  };
  // Lists are parsed as a tree, not emitted item by item: indentation carries
  // nesting, and a single `inList` flag cannot express depth. The flag version
  // also closed the <ol> whenever a sub-list interrupted it, so the numbering
  // restarted from 1 on the following item.
  const ITEM = /^([ \t]*)(?:([-*])|(\d+)\.)\s+(.*)$/;
  const indentOf = (s) => s.replace(/\t/g, "    ").length;
  const renderItems = (nodes) => {
    let out = "";
    for (let i = 0; i < nodes.length;) {
      const type = nodes[i].type;
      const group = [];
      while (i < nodes.length && nodes[i].type === type) group.push(nodes[i++]);
      const start =
        type === "ol" && group[0].num !== 1 ? ` start="${group[0].num}"` : "";
      out += `<${type}${start}>`;
      for (const n of group) {
        const task = type === "ul" && /^\[([ xX])\]\s+(.*)$/.exec(n.text);
        const cls = task
          ? ` class="task${task[1].toLowerCase() === "x" ? " done" : ""}"`
          : "";
        out += `<li${cls}>${inline(task ? task[2] : n.text)}${
          n.kids.length ? renderItems(n.kids) : ""
        }</li>`;
      }
      out += `</${type}>`;
    }
    return out;
  };
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.startsWith("```")) {
      if (!inCode) {
        flushPara();
        const fence = rawLines[li].slice(3).trim().toLowerCase();
        codeFence = fence.split(/\s+/)[0];
        codeLang = LANG_BY_FENCE[codeFence] || null;
        codeBuf = [];
        inCode = true;
      } else {
        const raw = codeBuf.join("\n");
        // A ```mermaid fence becomes a diagram host: the source rides on
        // data-mmd for mountMermaid() to render (and re-render on theme
        // change), and the escaped source stays visible as the before-JS /
        // load-failure fallback so the block is never blank. Source mode
        // (renderPlain) still shows the raw fence, so nothing is hidden there.
        if (codeFence === "mermaid")
          html += `<pre class="mermaid" data-mmd="${encodeURIComponent(raw)}">${esc(raw)}</pre>`;
        else
          html += `<pre class="code"><code>${highlight(raw, codeLang)}</code></pre>`;
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(rawLines[li]);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      let j = li;
      const block = [];
      while (j < lines.length && /^\s*\|/.test(lines[j])) {
        block.push(lines[j]);
        j++;
      }
      if (block.length >= 2 && /^\s*\|[\s:|-]+\|?\s*$/.test(block[1])) {
        flushPara();
        html +=
          "<table><tr>" +
          splitRow(block[0])
            .map((c) => `<th>${inline(c)}</th>`)
            .join("") +
          "</tr>";
        for (let k = 2; k < block.length; k++)
          html +=
            "<tr>" +
            splitRow(block[k])
              .map((c) => `<td>${inline(c)}</td>`)
              .join("") +
            "</tr>";
        html += "</table>";
        li = j - 1;
        continue;
      }
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const lvl = h[1].length;
      const rawText = rawLines[li].replace(/^\s*#{1,6}\s+/, "");
      const id = headingId(rawText);
      const isFirstH1 = lvl === 1 && firstH1;
      if (isFirstH1) firstH1 = false;
      // On SKILL.md the first H1 is the skill slug (e.g. acme-brand-system);
      // render it humanized like the detail title, so the body doesn't lead
      // with a raw hyphenated slug that clashes with the header above.
      const inner =
        isFirstH1 &&
        fmFile === "SKILL.md" &&
        humanTitle &&
        slugify(rawText) === slugify(humanTitle)
          ? esc(humanTitle)
          : inline(h[2]);
      html += `<h${lvl} id="${esc(id)}">${inner}</h${lvl}>`;
      continue;
    }
    if (ITEM.test(line)) {
      flushPara();
      // Consume the whole contiguous list block. A blank line is swallowed
      // when another item follows it, so a loose list (blank lines between
      // steps) stays one list instead of restarting at 1.
      const roots = [],
        stack = [];
      let j = li;
      for (; j < lines.length; j++) {
        if (lines[j].trim() === "") {
          let k = j + 1;
          while (k < lines.length && lines[k].trim() === "") k++;
          if (k >= lines.length || !ITEM.test(lines[k])) break;
          j = k - 1;
          continue;
        }
        const m = ITEM.exec(lines[j]);
        if (!m) break;
        const node = {
          indent: indentOf(m[1]),
          type: m[2] ? "ul" : "ol",
          num: m[2] ? 0 : parseInt(m[3], 10),
          text: m[4],
          kids: [],
        };
        while (stack.length && stack[stack.length - 1].indent >= node.indent)
          stack.pop();
        (stack.length ? stack[stack.length - 1].kids : roots).push(node);
        stack.push(node);
      }
      html += renderItems(roots);
      li = j - 1;
      continue;
    }
    if (/^\s*&gt;\s?/.test(line)) {
      flushPara();
      // One blockquote for the whole contiguous `>` run, not one per line; a
      // bare `>` line starts a new paragraph inside it.
      const quoted = [[]];
      let j = li;
      for (; j < lines.length && /^\s*&gt;/.test(lines[j]); j++) {
        const t = lines[j].replace(/^\s*&gt;\s?/, "").trim();
        if (t === "") quoted.push([]);
        else quoted[quoted.length - 1].push(t);
      }
      html +=
        "<blockquote>" +
        quoted
          .filter((p) => p.length)
          .map((p) => `<p>${inline(p.join(" "))}</p>`)
          .join("") +
        "</blockquote>";
      li = j - 1;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara();
      html += "<hr>";
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  if (inCode)
    html += `<pre class="code"><code>${highlight(codeBuf.join("\n"), codeLang)}</code></pre>`;
  return html;
}

/* ---------- appearance ---------- */
// Three states, cycled by one button: the OS preference is a real choice, not
// the absence of one, so it stays in the cycle instead of being the fallback
// you land on by clearing a setting.
const THEMES = ["system", "light", "dark"];
const THEME_KEY = "skill-loom:theme";
function nextTheme(cur) {
  const i = THEMES.indexOf(cur);
  return THEMES[(i < 0 ? 0 : i + 1) % THEMES.length];
}
// `system` removes the attribute entirely, so :root keeps `color-scheme:
// light dark` and light-dark() follows the OS again.
function applyTheme(t) {
  const theme = THEMES.includes(t) ? t : "system";
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  // The icon itself is picked by CSS from the three glyphs already in the
  // markup, so it is correct at first paint; only the wording is set here.
  const btn = $("#theme-btn");
  if (btn) {
    const label = { system: "System", light: "Light", dark: "Dark" }[theme];
    btn.title = `Appearance: ${label} (click for ${
      { system: "Light", light: "Dark", dark: "System" }[theme]
    })`;
    btn.setAttribute("aria-label", `Appearance: ${label}`);
  }
  return theme;
}
function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    // private mode / storage disabled: fall back to the OS preference
  }
  applyTheme(stored);
}
function cycleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "system";
  const next = applyTheme(nextTheme(cur));
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // nothing to persist to; the choice still holds for this page
  }
  // Diagrams bake their palette in at render time, so retheme any on screen.
  restyleMermaid();
}

/* ---------- events + boot ---------- */
document.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest("#theme-btn")) {
    cycleTheme();
    return;
  }
  if (suppressClickOnce) {
    suppressClickOnce = false;
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  // In-page anchor in a rendered doc: scroll the target heading into view
  // inside the viewer instead of letting the browser reload on the hash.
  const docAnchor =
    e.target instanceof Element ? e.target.closest("a.docanchor") : null;
  if (docAnchor) {
    e.preventDefault();
    const id = decodeURIComponent(
      (docAnchor.getAttribute("href") || "").slice(1),
    );
    const tgt = id && document.getElementById(id);
    if (tgt) tgt.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const selCard =
    e.target instanceof Element ? e.target.closest("[data-skill]") : null;
  if (selCard && (curView === "skills" || curView === "archived")) {
    const onBox = e.target.closest(".selbox, .selcol");
    if (onBox || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      libToggleSel(selCard.dataset.skill);
      return;
    }
    if (e.shiftKey) {
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      libSelRange(selCard.dataset.skill);
      return;
    }
  }
  const t =
    e.target instanceof Element
      ? e.target.closest(
          "[data-go],[data-skill],[data-file],[data-gallery],[data-galfile],[data-mode],[data-hash-open],[data-toggle],[data-consumer],[data-inplace],[data-restore],[data-remote],[data-coming],[data-nameadd],[data-namedel],[data-runtimeadd],[data-runtimepreset],[data-linkall],[data-source]",
        )
      : null;
  if (!t) {
    // click on empty library space clears the selection + cursor
    if (curView === "skills" || curView === "archived") {
      libSelClear();
      libDeselect();
    }
    return;
  }
  if (t.dataset.go === "skills" && t.id === "nav-skills") goSkillsTab();
  else if (t.dataset.go) {
    if (t.dataset.go === "skills") lastDetail = null;
    // Clicking the Config nav lands on the Rules pane, never a
    // remembered pane. Keyed on the nav element id, not curView: the
    // Config view itself runs under curView === "config", so a
    // curView check would miss this case.
    if (t.id === "nav-config") configPane = "rules";
    go(t.dataset.go);
  } else if (t.dataset.skill) {
    // In a read-only source the group is half the identity: carry the clicked
    // row's group over, or the detail would ask for a name the server cannot
    // place. The vault has no groups, so this is a no-op there.
    if (curSource !== "personal") srcGroup = t.dataset.group || "";
    go("detail", t.dataset.skill);
  } else if (t.dataset.file) selectFile(t.dataset.file);
  else if (t.dataset.gallery) openGallery();
  // A tile opens the picture over the page, not the file behind it: the grid is
  // there to be looked through, and the ring it opens is every image the
  // gallery is currently showing, in the order it shows them.
  else if (t.dataset.galfile) {
    const paths = galleryOrder(galleryFiles());
    openLightbox(paths, Math.max(0, paths.indexOf(t.dataset.galfile)));
  } else if (t.dataset.mode) setMode(t.dataset.mode);
  else if (t.dataset.hashOpen) showCommit(t.dataset.hashOpen, t.dataset.subj);
  else if (t.dataset.toggle) toggleRuntime(t.dataset.toggle, t);
  else if (t.dataset.consumer) toggleConsumer(t.dataset.consumer, t);
  else if (t.dataset.inplace) toggleInplace(t.dataset.inplace, t);
  else if (t.dataset.linkall) linkEverywhere(t.dataset.linkall);
  else if (t.dataset.source) selectSource(t.dataset.source);
  else if (t.dataset.restore) doRestore(t.dataset.restore);
  else if (t.dataset.remote) doRemote();
  else if (t.dataset.runtimeadd) doRuntimeAdd();
  else if (t.dataset.runtimepreset)
    doPresetAdd(t.dataset.runtimepreset, t.dataset.path);
  else if (t.dataset.nameadd) doNameAdd();
  else if (t.dataset.namedel) doNameDel(t.dataset.namedel);
  else if (t.dataset.coming) comingSoon(t.dataset.coming);
});
// Marquee drag-select over the library (grid + list). Mousedown inside
// #groups, drag past a small threshold to rubber-band; every card/row the
// band intersects is selected. Holding Cmd/Ctrl/Shift adds to the current
// selection instead of replacing it. A real drag swallows the click it
// would otherwise emit (so it never opens a detail).
let dragSel = null;
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (curView !== "skills" && curView !== "archived") return;
  const groups = document.getElementById("groups");
  if (!groups || !groups.contains(e.target)) return;
  dragSel = {
    x0: e.clientX,
    y0: e.clientY,
    moved: false,
    base: e.metaKey || e.ctrlKey || e.shiftKey ? new Set(libSel) : new Set(),
    box: null,
  };
});
document.addEventListener("mousemove", (e) => {
  if (!dragSel) return;
  const dx = e.clientX - dragSel.x0,
    dy = e.clientY - dragSel.y0;
  if (!dragSel.moved && Math.hypot(dx, dy) < 5) return;
  if (!dragSel.moved) {
    dragSel.moved = true;
    const box = document.createElement("div");
    box.id = "marquee";
    document.body.appendChild(box);
    dragSel.box = box;
    document.body.style.userSelect = "none";
  }
  const x = Math.min(e.clientX, dragSel.x0),
    y = Math.min(e.clientY, dragSel.y0),
    w = Math.abs(dx),
    h = Math.abs(dy);
  Object.assign(dragSel.box.style, {
    left: x + "px",
    top: y + "px",
    width: w + "px",
    height: h + "px",
  });
  const R = { left: x, top: y, right: x + w, bottom: y + h };
  const next = new Set(dragSel.base);
  for (const c of libVisibleEls()) {
    const b = c.getBoundingClientRect();
    if (!(
      b.right < R.left ||
      b.left > R.right ||
      b.bottom < R.top ||
      b.top > R.bottom
    ))
      next.add(c.dataset.skill);
  }
  libSel = next;
  libSelApply();
});
document.addEventListener("mouseup", () => {
  if (!dragSel) return;
  const dragged = dragSel.moved;
  dragSel.box?.remove();
  document.body.style.userSelect = "";
  dragSel = null;
  if (dragged) {
    if (libSel.size) libSelAnchor = [...libSel][libSel.size - 1];
    suppressClickOnce = true;
  }
});
document.addEventListener("contextmenu", (e) => {
  const card =
    e.target instanceof Element ? e.target.closest("[data-skill]") : null;
  if (!card || (curView !== "skills" && curView !== "archived")) return;
  e.preventDefault();
  // Right-clicking a row outside the selection makes it the sole target.
  if (!libSel.has(card.dataset.skill)) {
    libSel = new Set([card.dataset.skill]);
    libSelAnchor = card.dataset.skill;
    libSelApply();
  }
  ctxOpen(e.clientX, e.clientY);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") ctxClose();
});
// ── Keyboard shortcuts + help overlay ────────────────────────────────
const SHORTCUTS = [
  ["?", "Toggle this help"],
  ["f", "Focus search"],
  ["⌥ 1 · 2 · 3", "My skills · Status · Config"],
  ["1…9", "Jump to source N"],
  ["n", "New skill"],
  ["← ↑ ↓ →", "Select a skill (library) · navigate (detail)"],
  ["↵ Enter", "Open selected skill (library)"],
  ["⌥ ← →", "Previous / next source (library)"],
  ["v", "Toggle Rendered / Source"],
  ["g", "Cycle grid / table / map (library)"],
  ["d", "Cycle grouping: none / each declared axis"],
  ["a", "Toggle active / archived skills"],
  ["s", "Cycle the status filter: all / each status in the set"],
  ["r", "Refresh from the vault"],
  ["t", "Cycle appearance: system / light / dark"],
  ["Esc", "Back · close · clear search"],
];
let helpOpen = false;
function openHelp() {
  if (document.getElementById("helpov")) return;
  const d = document.createElement("div");
  d.id = "helpov";
  d.innerHTML =
    `<div class="helpcard"><div class="helphd">Keyboard shortcuts</div>` +
    SHORTCUTS.map(
      ([k, v]) =>
        `<div class="helprow"><kbd>${esc(k)}</kbd><span>${esc(v)}</span></div>`,
    ).join("") +
    `</div>`;
  d.addEventListener("click", (e) => {
    if (e.target === d) closeHelp();
  });
  document.body.appendChild(d);
  helpOpen = true;
}
function closeHelp() {
  document.getElementById("helpov")?.remove();
  helpOpen = false;
}
function toggleHelp() {
  helpOpen ? closeHelp() : openHelp();
}
document.addEventListener("keydown", (e) => {
  const el = e.target;
  const typing =
    el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable);
  if (e.key === "Escape") {
    if (helpOpen) return closeHelp();
    if (typing) {
      // First Escape clears a non-empty search field and keeps focus; a
      // second Escape (now empty), or Escape in any other input, blurs.
      if (el.id === "search" && el.value) {
        el.value = "";
        searchQ = "";
        filterLibrary();
        return;
      }
      return el.blur();
    }
    // Leaving a detail returns to the list it was opened from. The archive is
    // Personal's own corner: reading a source while the flag rides along must
    // still land on that source's list, not on the vault's archive.
    if (curView === "detail")
      return void go(
        curSource === "personal" && libArchived ? "archived" : "skills",
      );
    // Same as the form's own Cancel (no confirm): a focused field blurs on the
    // first Escape, so leaving still takes a deliberate second press.
    if (curView === "new") return void go("skills");
    if (curView === "skills" || curView === "archived") {
      // Escape resets the search even when the field isn't focused (e.g.
      // after typing then clicking away), before it clears any selection.
      if (searchQ) {
        searchQ = "";
        const inp = $("#search");
        if (inp) inp.value = "";
        filterLibrary();
        return;
      }
      if (libSel.size || libSelName) {
        libSelClear();
        libDeselect();
        return;
      }
    }
    return;
  }
  if (e.key === "?" && !typing) {
    e.preventDefault();
    return toggleHelp();
  }
  // Cmd/Ctrl+A: context-aware select-all. My skills / Archived select every
  // visible row; the detail viewer selects the shown file's text; Status
  // and Config select nothing.
  if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
    if (typing) return; // inputs keep their native select-all
    if (curView === "skills" || curView === "archived") {
      e.preventDefault();
      return libSelectAllVisible();
    }
    if (curView === "detail") {
      const v = document.getElementById("viewer");
      if (v) {
        e.preventDefault();
        const sel = window.getSelection();
        const rg = document.createRange();
        rg.selectNodeContents(v);
        sel.removeAllRanges();
        sel.addRange(rg);
      }
      return;
    }
    e.preventDefault();
    return;
  }
  // Alt+Left/Right is the chip band's keyboard twin, so it answers where the
  // band is: the lists. A detail has no band to move, and no skill in the next
  // source corresponds to the open one. Must run before the modifier guard
  // below, which drops Alt.
  if (
    e.altKey &&
    !typing &&
    sources.length > 1 &&
    (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
    (curView === "skills" || curView === "archived")
  ) {
    e.preventDefault();
    const i = sources.findIndex((s) => s.id === curSource);
    const ni = Math.min(
      sources.length - 1,
      Math.max(0, i + (e.key === "ArrowLeft" ? -1 : 1)),
    );
    if (ni !== i) selectSource(sources[ni].id);
    return;
  }
  // Alt+1/2/3 are the three destinations in the top nav; bare digits below
  // belong to the source band. The band is the busier switch, so it gets the
  // unmodified keys. e.code, not e.key: on macOS Option+1 types "¡".
  if (e.altKey && !typing) {
    const m = /^Digit([1-3])$/.exec(e.code || "");
    if (m) {
      e.preventDefault();
      if (m[1] === "1") return goSkillsTab();
      if (m[1] === "2") return void go("status");
      configPane = "rules";
      return void go("config");
    }
  }
  if (helpOpen || typing || e.metaKey || e.ctrlKey || e.altKey) return;
  // The archive is the library over a different set (curView is "archived"
  // there), so it answers to the same shortcuts.
  const inLib = curView === "skills" || curView === "archived";
  if (e.key === "f" || e.key === "F") {
    e.preventDefault();
    if (!inLib) go("skills");
    // Focus AND select: a second F (or focusing with a query already typed)
    // selects the existing text so the next keystroke replaces it.
    setTimeout(() => {
      const s = $("#search");
      if (s) {
        s.focus();
        s.select();
      }
    }, 0);
    return;
  }
  // Bare 1..9 selects the Nth source. It works from anywhere: pressing it
  // outside the library moves there first, so the key means the same thing in
  // every view instead of dying in two of the three.
  const sn = /^[1-9]$/.test(e.key) ? sources[Number(e.key) - 1] : null;
  if (sn) {
    e.preventDefault();
    if (curView !== "skills" && curView !== "archived") go("skills");
    if (sn.id !== curSource) selectSource(sn.id);
    return;
  }
  if (
    e.key === "a" &&
    curSource === "personal" &&
    (curView === "skills" || curView === "archived")
  ) {
    e.preventDefault();
    const t = archiveToggleTarget(libArchived);
    setLibArchived(t.libArchived);
    return void go(t.view);
  }
  if (e.key === "r") {
    e.preventDefault();
    return void doRefresh();
  }
  if (e.key === "t") {
    e.preventDefault();
    return void cycleTheme();
  }
  if (inLib && curSource !== "personal") {
    if (e.key.startsWith("Arrow")) {
      if (!srcListNav(e.key)) return;
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && srcCursor) {
      srcGroup = srcCursor.group;
      return void go("detail", srcCursor.name);
    }
    return; // read-only source: no new / grid / group / archive shortcuts
  }
  if (inLib) {
    // Creating is a live-vault action: the archive does not offer it.
    if (e.key === "n" && !libArchived) return void go("new");
    if (e.key === "g") {
      e.preventDefault();
      // The archive has no map to cycle into: extraction skips `.archive`, and
      // the view toggle does not offer it there either.
      const modes = libArchived ? ["grid", "list"] : ["grid", "list", "map"];
      const at = modes.indexOf(libView);
      setLibView(modes[(at + 1) % modes.length]);
      // The ledger's "updated" sort has no meaning outside the table.
      if (libView !== "list" && sortMode === "updated") {
        sortMode = "name";
        sortDir = 1;
      }
      return void repaintLibrary();
    }
    if (e.key === "d") {
      e.preventDefault();
      // ["none", ...declared axis ids]; a groupAxis a reload (r) no longer
      // declares falls back to "none" instead of getting stuck past the end.
      const cycle = ["none", ...axisList().map((a) => a.id)];
      const i = cycle.indexOf(groupAxis);
      setGroupAxis(cycle[(i + 1) % cycle.length] ?? "none");
      return void repaintLibrary();
    }
    if (e.key === "s") {
      e.preventDefault();
      return void cycleStatusFilter();
    }
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      return libNav(e.key, e.shiftKey);
    }
    if (e.key === "Enter" && libSelName) return void go("detail", libSelName);
  }
  if (curView === "config" && e.key.startsWith("Arrow")) {
    const panes = [...document.querySelectorAll("#cfg-nav a")].map(
      (a) => a.dataset.pane,
    );
    const i = panes.indexOf(configPane);
    if (i < 0) return;
    const back = e.key === "ArrowUp" || e.key === "ArrowLeft";
    const ni = Math.min(panes.length - 1, Math.max(0, i + (back ? -1 : 1)));
    if (ni !== i) {
      e.preventDefault();
      switchConfigPane(panes[ni]);
    }
    return;
  }
  if (curView !== "detail") return;
  // Rendered/Source toggle: shown for Markdown in both the vault and a
  // read-only source, so it stays above the source branch below.
  if (e.key === "v") {
    if (!$("#seg")?.classList.contains("vhide")) {
      e.preventDefault();
      setMode(viewMode === "rendered" ? "source" : "rendered");
    }
    return;
  }
  if (curSource !== "personal") {
    // Read-only source detail: Up/Down move through files, Left/Right through
    // the source's sibling skills. Both lists are read from the rail DOM.
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      // Rows that carry a file, so the gallery row above them does not sit in
      // the ring as a step that goes nowhere.
      const files = [
        ...document.querySelectorAll("#srcfilelist .file[data-srcfile]"),
      ].map((b) => b.dataset.srcfile);
      const i = files.indexOf(currentFile);
      if (i < 0) return;
      const to = e.key === "ArrowUp" ? files[i - 1] : files[i + 1];
      if (to) {
        e.preventDefault();
        srcSelectFile(to);
      }
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      // The whole source in list order, not the rail: the rail holds one
      // collection, and stopping at its last skill would trap you there. The
      // vault's detail does the same through libraryOrder().
      const i = srcOrder.findIndex(
        (o) => o.name === (srcSkill && srcSkill.name) && o.group === srcGroup,
      );
      if (i < 0) return;
      const to = e.key === "ArrowLeft" ? srcOrder[i - 1] : srcOrder[i + 1];
      if (to) {
        e.preventDefault();
        srcGroup = to.group;
        go("detail", to.name);
      }
    }
    return;
  }
  const skillKey = e.key === "ArrowLeft" || e.key === "ArrowRight";
  const fileKey = e.key === "ArrowUp" || e.key === "ArrowDown";
  if (skillKey) {
    const order = libraryOrder();
    const i = order.indexOf(current);
    if (i < 0) return;
    const to = e.key === "ArrowLeft" ? order[i - 1] : order[i + 1];
    if (to) {
      e.preventDefault();
      go("detail", to);
    }
  } else if (fileKey) {
    const files = [
      ...document.querySelectorAll("#filelist .file[data-file]"),
    ].map((b) => b.dataset.file);
    const i = files.indexOf(currentFile);
    if (i < 0) return;
    const to = e.key === "ArrowUp" ? files[i - 1] : files[i + 1];
    if (to) {
      e.preventDefault();
      selectFile(to);
    }
  }
});
async function linkEverywhere(name) {
  const nm = name ?? current;
  const r = await api("/api/link-skill-everywhere", { name: nm, apply: true });
  if (!r.ok) return toast(r.data.error || "failed");
  const n = (r.data.actions || []).length;
  toast(n ? `Linked into ${n} runtime${n === 1 ? "" : "s"}` : "Already linked");
  await loadState();
  if (curView === "detail") return void go("detail", nm);
  // Status view: swap only this row in place, so the scroll position is kept
  // instead of jumping to the top on a full re-render.
  const row = document.querySelector(`tr[data-cov="${nm}"]`);
  const skill = (state.skills || []).find((s) => s.name === nm);
  if (row && skill)
    row.outerHTML = coverageRow(skill, Object.keys(state.consumers), true);
  else render();
}
async function toggleRuntime(consumer, el) {
  const on = !el.classList.contains("on");
  const r = await api("/api/link-toggle", {
    consumer,
    name: current,
    on,
    apply: true,
  });
  if (!r.ok) return toast(r.data.error || "failed");
  if (r.data.skipped && r.data.skipped.length) toast(r.data.skipped[0]);
  await loadState();
  go("detail", current);
}
async function toggleConsumer(consumer, el) {
  const on = !el.classList.contains("on");
  const r = await api("/api/link-toggle", { consumer, on, apply: true });
  if (!r.ok) return toast(r.data.error || "failed");
  toast(
    on
      ? `Linking into ${rtName(consumer)}`
      : `Unlinked from ${rtName(consumer)}`,
  );
  await loadState();
  render();
}
async function toggleInplace(consumer, el) {
  const on = !el.classList.contains("on");
  // Deactivating removes the vault from the runtime's config — that hides
  // every skill from it — so confirm first. Activating is low-stakes.
  if (!on) {
    const dry = await api("/api/inplace-toggle", {
      consumer,
      on,
      apply: false,
    });
    if (!dry.ok) return toast(dry.data.error || "failed");
    if (
      !(await confirmActions(
        `Deactivate ${rtName(consumer)}? Hides every skill from it until you turn it back on.`,
        dry.data.actions,
      ))
    )
      return;
  }
  const r = await api("/api/inplace-toggle", {
    consumer,
    on,
    apply: true,
  });
  if (!r.ok) return toast(r.data.error || "failed");
  toast(r.data.message || (on ? "Activated" : "Deactivated"));
  await loadState();
  render();
}
async function doRestore(name) {
  const dry = await api("/api/restore", { name, apply: false });
  if (!dry.ok) return toast(dry.data.message || dry.data.error);
  if (!(await confirmActions(`Restore "${name}"?`, dry.data.actions))) return;
  const wet = await api("/api/restore", { name, apply: true });
  toast(wet.data.message || wet.data.error);
  await loadState();
  go("skills");
}
async function doRemote() {
  const url = await promptDialog(
    "Git remote URL (origin):",
    (sync && sync.remote) || "",
    "Save",
  );
  if (!url) return;
  const wet = await api("/api/remote", { url, apply: true });
  toast(wet.data.message || wet.data.error);
  sync = (await api("/api/sync")).data;
  render();
}
$("#refresh").addEventListener("click", () => doRefresh());
$("#help-btn")?.addEventListener("click", openHelp);

let lastStateAt = 0;
// ── graph-freshness badge ────────────────────────────────────────────
const FRESH_COPY_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const FRESH_CHECK_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
let freshData = null;
// Whether the collapsed "N families done" line is expanded. Module state, not
// DOM state: the popover repaints every 5s while a run is live, and a class on
// the rebuilt markup would fold the list back mid-read.
let freshDoneOpen = false;
let freshnessPoll = null;

// Relative "updated X ago". Empty string for a missing/unparseable timestamp.
function agoLabel(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "just now";
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Clipboard with a legacy fallback: the dashboard can bind a non-local host over
// http, where navigator.clipboard is undefined (not a secure context).
function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(
      () => toast("Command copied"),
      () => toast("Copy failed"),
    );
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  try {
    ta.select();
    document.execCommand("copy");
    toast("Command copied");
  } catch {
    toast("Copy failed");
  } finally {
    document.body.removeChild(ta);
  }
}

// The pill's colour + label. null -> no pill (no graph). Colour priority is
// stuck > pending > behind > fresh; "behind" alone stays neutral.
function freshSummary(d) {
  if (!d || !d.hasGraph) return null;
  const stuck = d.pending.filter((f) => f.state === "stuck").length;
  const pend = d.pending.filter((f) => f.state === "pending").length;
  const k = d.commitsBehind;
  const running =
    d.run && (d.run.state === "extracting" || d.run.state === "applying");
  const stale = (d.stale || []).length;
  const behind = stale
    ? ` · ${stale} stale`
    : typeof k === "number" && k > 0
      ? ` · ${k} behind`
      : "";
  if (stuck)
    return {
      cls: "bad",
      label: `${stuck} stuck`,
      behind: pend ? ` · ${pend} pending` : behind,
    };
  if (running) {
    // In the cross pass "Refreshing 6/6" is a contradiction — six of six done,
    // still running. The pill names the phase the panel names.
    const cross = liveCross(d.run);
    return {
      cls: "warn",
      label: cross
        ? `Linking ${cross.done}/${cross.total}`
        : `Refreshing ${d.run.completed}/${d.run.total}`,
      behind,
    };
  }
  if (d.armedAt) {
    // The quiet window the post-commit hook waits out is 60s, so the old
    // "minutes above 60, a bare 'Refresh due' below" put every real wait in
    // the branch without a number: the countdown could not appear at all.
    // One threshold, both sides carry the figure, and zero says it is going
    // rather than freezing on a number that stopped falling.
    const wait = Math.max(0, d.armedAt - Math.floor(Date.now() / 1000));
    return {
      cls: "warn",
      label: !wait
        ? "Starting now"
        : wait >= 60
          ? `Refresh in ${Math.ceil(wait / 60)}m`
          : `Refresh in ${wait}s`,
      behind,
    };
  }
  if (pend) return { cls: "warn", label: `${pend} pending`, behind };
  if (!d.freshThroughCommit && !d.updatedAt)
    return { cls: "", label: "Graph", behind }; // graph present, no status yet
  if (typeof k === "number" && k > 0)
    return { cls: "", label: "Graph", behind };
  if (k === 0) return { cls: "ok", label: "Graph fresh", behind: "" };
  // commitsBehind === null with a fresh sha present: the sha isn't an ancestor
  // of HEAD (rebased/rewritten), so freshness can't be verified — never green.
  return { cls: "", label: "Graph", behind: "" };
}

function freshPollDelay(d) {
  const running =
    d?.run && (d.run.state === "extracting" || d.run.state === "applying");
  if (running) return 5000;
  // Armato: si continua a guardare, altrimenti la finestra di quiete scade e il
  // pannello resta fermo su "fra 2m" fino al prossimo caricamento.
  return d?.armedAt ? 10000 : null;
}

function famRowHtml(f) {
  const badgeCls = f.state === "stuck" ? "bad" : "warn";
  const failTxt = `${f.fails} fail${f.fails === 1 ? "" : "s"}`;
  const extra =
    f.state === "stuck"
      ? `<div class="fp-cmd"><code>${esc(f.command)}</code><button class="fresh-copy" data-cmd="${esc(f.command)}" title="Copy command" aria-label="Copy command">${FRESH_COPY_SVG}</button></div>`
      : `<div class="fp-auto">auto-retrying on the next refresh</div>`;
  return (
    `<div class="fp-fam"><div class="fp-fam-top">` +
    `<span class="fp-name">${esc(f.family)}</span>` +
    `<span class="fp-badge ${badgeCls}">${esc(f.state)} · ${esc(failTxt)}</span></div>` +
    (f.reason ? `<div class="fp-reason">${esc(f.reason)}</div>` : "") +
    extra +
    `</div>`
  );
}

// The run's progress bar. It has to count what the headline counts: the line
// right above it reads `run.completed` of `run.total`, so a bar driven by a
// different rule (family_state alone drops entries the parser doesn't know, and
// a family that finished extraction sits in "applying", not "done") renders a
// percentage that contradicts the sentence eight pixels away. Two tones because
// the run has two phases: extraction fills the bar, the serial apply turns it
// green, reusing the dot colours the rows already carry.
// The cross pass, when the status file reports one still in progress.
function liveCross(run) {
  const c = run && run.cross;
  return c && c.total > 0 && c.done < c.total ? c : null;
}
function runBarHtml(run) {
  if (!run) return "";
  const total = run.total || (run.familyState ? run.familyState.length : 0);
  if (!total) return "";
  // The two layers are stacked, not concatenated, so each carries its share of
  // the WHOLE bar: green (confirmed) paints over the teal (extracted) rather
  // than continuing it.
  const frac = (n, of) => (Math.round((n / of) * 1000) / 1000).toString();
  // Cross pass: extraction is through, so the teal base is full and the green
  // sweep tracks the per-skill confirmations. Same two layers, same colours —
  // the second phase reads as the bar filling in, not as a new element. Without
  // this the bar sat at 100% green while the panel said 2 of 11.
  const cross = liveCross(run);
  if (cross)
    return (
      `<div class="fp-bar"><i style="transform:scaleX(1)"></i>` +
      `<i class="done" style="transform:scaleX(${frac(cross.done, cross.total)})"></i></div>`
    );
  const done = (run.familyState || []).filter((f) => f.state === "done").length;
  const completed = Math.min(run.completed, total);
  return (
    `<div class="fp-bar">` +
    (completed
      ? `<i style="transform:scaleX(${frac(completed, total)})"></i>`
      : "") +
    (done
      ? `<i class="done" style="transform:scaleX(${frac(done, total)})"></i>`
      : "") +
    `</div>`
  );
}

// One row per family in the run. A counter could only say "2 of 5"; two done
// and one failed reads exactly like one of each until every family carries its
// own state, which is the whole reason run.family_state exists.
function runFamilyRowsHtml(run, pendingNames) {
  if (!run || !run.familyState || !run.familyState.length) return "";
  // A family that failed in THIS run and sits in the retry queue was rendered
  // twice — a red block up here with reason+command, a yellow card below with
  // the same reason and the retry note. Eight cards for four facts. The run row
  // stays (the run log must account for every family), but it collapses to one
  // line pointing at the queue, which owns the reason and the retry story.
  const queued = pendingNames || new Set();
  // A running family has no duration yet, only a start: show how long it has
  // been going, or the panel says "running" and nothing else.
  const secs = (f) => {
    // A sub-second duration is a checkpoint restore, not an extraction: name
    // the cause instead of printing the "0s" it rounds to.
    if (f.seconds != null)
      return f.seconds < 1 ? ` · cache` : ` · ${Math.round(f.seconds)}s`;
    const t = f.startedAt ? Date.parse(f.startedAt) : NaN;
    if (!Number.isFinite(t)) return "";
    return ` · ${Math.max(0, Math.round((Date.now() - t) / 1000))}s`;
  };
  const rowHtml = (f) => {
    const label =
      f.state === "done"
        ? `done${secs(f)}`
        : f.state === "running"
          ? `running${secs(f)}`
          : f.state === "applying"
            ? // Extraction is through; the serial validation and replace has
              // not run yet, so the family is neither done nor still working.
              `extracted${secs(f)}`
            : f.state === "failed"
              ? queued.has(f.family)
                ? "failed · in retry queue below"
                : "failed"
              : "queued";
    const why =
      f.state === "failed" && !queued.has(f.family)
        ? (f.reason ? `<div class="fp-reason">${esc(f.reason)}</div>` : "") +
          `<div class="fp-cmd"><code>graphify-refresh.py ${esc(f.family)}</code><button class="fresh-copy" data-cmd="graphify-refresh.py ${esc(f.family)}" title="Copy command" aria-label="Copy command">${FRESH_COPY_SVG}</button></div>`
        : "";
    return (
      `<div class="fp-row ${f.state}"><span class="d"></span>` +
      `<span class="fp-name">${esc(f.family)}</span>` +
      `<span class="fp-sub">${f.skills} skill${f.skills === 1 ? "" : "s"}</span>` +
      `<span class="fp-state">${esc(label)}</span></div>` +
      why
    );
  };
  // Finished families are banked work: past three of them they fold into one
  // openable line, so the part of the run still moving keeps the panel. The
  // threshold exists because a fold standing in for one or two rows costs a
  // click and saves nothing. The fold line sits where the done block starts —
  // the sort puts done last — so opening it reveals rows below the toggle, not
  // above it.
  const done = run.familyState.filter((f) => f.state === "done");
  const live = run.familyState.filter((f) => f.state !== "done");
  const folding = done.length >= 3;
  const doneSkills = done.reduce((n, f) => n + f.skills, 0);
  const foldRow = folding
    ? `<button class="fp-collapse" data-fresh-done aria-expanded="${freshDoneOpen}"><span class="d"></span>` +
      `${done.length} families done` +
      `<span class="n">${doneSkills} skill${doneSkills === 1 ? "" : "s"}</span>` +
      `<span class="cv">${freshDoneOpen ? "▾" : "▸"}</span></button>`
    : "";
  const rows = folding
    ? live.map(rowHtml).join("") +
      foldRow +
      (freshDoneOpen ? done.map(rowHtml).join("") : "")
    : run.familyState.map(rowHtml).join("");
  // During the cross pass the things moving are the skills being confirmed:
  // each gets a live row in the run's own language. The pass runs several at a
  // time, so one row would hide the others. The status file carries only the
  // names, no start time, so a row says what and not how long.
  const cross = liveCross(run);
  const crossNames = (cross && cross.current) || [];
  const crossRow = cross
    ? (crossNames.length ? crossNames : ["…"])
        .map(
          (name) =>
            `<div class="fp-row running"><span class="d"></span>` +
            `<span class="fp-name">${esc(name)}</span>` +
            `<span class="fp-state">linking</span></div>`,
        )
        .join("")
    : "";
  return `<div class="fp-sec">This run</div>` + crossRow + rows;
}

// Families whose markdown moved after the graph was built. Read from git, so
// they are known before any run picks them up.
function staleRowsHtml(stale) {
  if (!stale || !stale.length) return "";
  const rows = stale
    .map(
      (s) =>
        `<div class="fp-row stale"><span class="d"></span>` +
        `<span class="fp-name">${esc(s.family)}</span>` +
        `<span class="fp-sub">${esc(s.skills.join(", "))}</span>` +
        `<span class="fp-state">${s.commits} commit${s.commits === 1 ? "" : "s"} behind</span></div>`,
    )
    .join("");
  return `<div class="fp-sec">Stale, not picked up yet</div>` + rows;
}

function freshPopHtml(d) {
  if (!d || !d.hasGraph) return "";
  const stuck = d.pending.filter((f) => f.state === "stuck").length;
  const pend = d.pending.filter((f) => f.state === "pending").length;
  const running =
    d.run && (d.run.state === "extracting" || d.run.state === "applying");
  const when = agoLabel(d.updatedAt);
  const head =
    `<div class="fp-head"><h3>Graph freshness</h3>` +
    (when ? `<span class="fp-when">updated ${esc(when)}</span>` : "") +
    `</div>`;
  const k = d.commitsBehind;
  const behindLine =
    typeof k === "number" && k > 0
      ? `<div class="fp-behind">Graph is <b>${k} commit${k === 1 ? "" : "s"} behind</b> HEAD.</div>`
      : "";
  let statusCls, statusText;
  if (stuck) {
    statusCls = "bad";
    statusText = `${stuck} famil${stuck === 1 ? "y" : "ies"} stuck`;
  } else if (running) {
    statusCls = "warn";
    // After extraction the run confirms cross-family links one touched skill at
    // a time, sequentially — on a full-vault pass it outlives the extraction.
    // Without naming the phase the panel read "Refreshing 47 of 47" with every
    // family done and no visible reason to still be running.
    const cross = d.run.cross;
    // The current skill lives in its own run row now (see runFamilyRowsHtml),
    // so the status line carries the count alone — the same name twice, eight
    // pixels apart, said nothing extra.
    statusText =
      cross && cross.total > 0 && cross.done < cross.total
        ? `Cross-linking ${cross.done} of ${cross.total} skills`
        : `Refreshing ${d.run.completed} of ${d.run.total} families`;
  } else if (pend) {
    statusCls = "warn";
    statusText = `${pend} famil${pend === 1 ? "y" : "ies"} pending`;
  } else if (!d.freshThroughCommit && !d.updatedAt) {
    statusCls = "off";
    statusText = "Freshness unknown";
  } else if (d.armedAt) {
    statusCls = "warn";
    statusText = "Refresh armed";
  } else if (k === 0) {
    statusCls = "ok";
    statusText = "Fresh";
  } else if (typeof k === "number" && k > 0) {
    statusCls = "ok";
    statusText = "No problems";
  } else {
    statusCls = "off";
    statusText = "Freshness unverified";
  }
  const status = `<div class="fp-status ${statusCls}"><span class="d"></span>${esc(statusText)}</div>`;
  const runLine = running
    ? `<div class="fp-behind">${d.run.workers} worker${d.run.workers === 1 ? "" : "s"}` +
      (d.run.lastCompleted
        ? ` · last: <b>${esc(d.run.lastCompleted)}</b>`
        : "") +
      (d.run.lastProvider ? ` via ${esc(d.run.lastProvider)}` : "") +
      `</div>`
    : "";
  const armed = d.armedAt
    ? `<div class="fp-behind">A refresh is armed and starts in <b id="fp-armed">${Math.max(0, Math.ceil(d.armedAt - Date.now() / 1000))}s</b>. The hook waits out a quiet window so a burst of commits pays one run.</div>`
    : "";
  const bar = runBarHtml(d.run);
  const famRows = runFamilyRowsHtml(
    d.run,
    new Set(d.pending.map((f) => f.family)),
  );
  const staleRows = staleRowsHtml(d.stale);
  let body;
  if (d.pending.length === 0) {
    const line = running
      ? "Family extraction is running; valid chunks are checkpointed before the serial graph update."
      : statusText === "Freshness unknown"
        ? "The graph exists but the refresh pipeline hasn't reported a status yet."
        : statusText === "Freshness unverified"
          ? "The graph was built on a commit that isn't in the current history (rebased or rewritten), so its freshness can't be verified."
          : typeof k === "number" && k > 0
            ? "No degenerate or failed families. Being a few commits behind is normal between refreshes."
            : "The knowledge graph is up to date through the latest commit.";
    const okCls = "fp-ok" + (statusCls === "off" ? " muted" : "");
    body = `<div class="${okCls}"><span class="ic">${FRESH_CHECK_SVG}</span><span>${line}</span></div>`;
  } else {
    body = `<div class="fp-div"></div>` + d.pending.map(famRowHtml).join("");
  }
  // The per-family rows replace the one-line run summary when the pipeline
  // writes them; older status files still get the counter.
  // With per-family rows on screen the generic "extraction is running" box
  // repeats what the rows already say; the pending block still earns its place.
  const explain = famRows && d.pending.length === 0 ? "" : body;
  // A 47-family run is taller than any viewport, so the list is the only part
  // that scrolls: the status, the bar and the run summary stay pinned, because
  // scrolling away the one line that says what the panel is about is worse than
  // the height. The scroller is a flex child (see .fp-scroll) rather than the
  // popover itself — a sticky header inside a scrolling popover lets rows slide
  // through its padding.
  // Only lists scroll. The one-line "nothing to report" note is not a list, so
  // it stays with the status it belongs to rather than becoming a one-item
  // scroll region.
  const lists = d.pending.length ? explain : "";
  const note = d.pending.length ? "" : explain;
  const scroller = famRows + lists + staleRows;
  return (
    head +
    status +
    behindLine +
    // The armed sentence was built and then dropped on the floor: the panel
    // said "Refresh armed" and never said when, which is the same gap the pill
    // had. It belongs under the status it explains.
    armed +
    (famRows ? bar : "") +
    (famRows ? "" : runLine) +
    note +
    (scroller ? `<div class="fp-scroll">${scroller}</div>` : "")
  );
}

// Repaint the header pill + popover contents from freshData. Hides both when
// there is no graph.
function updateFreshness() {
  const host = $("#freshness");
  const pop = $("#fresh-pop");
  if (!host) return;
  const sum = freshSummary(freshData);
  if (!sum) {
    host.hidden = true;
    host.innerHTML = "";
    if (pop && pop.matches(":popover-open")) pop.hidePopover();
    return;
  }
  host.hidden = false;
  host.innerHTML =
    `<button class="fresh-pill ${sum.cls}" popovertarget="fresh-pop" title="Graph freshness" aria-label="Graph freshness: ${esc(sum.label)}${esc(sum.behind)}">` +
    // The label is its own element so the armed ticker can rewrite the count
    // once a second without touching the rest of the pill.
    `<span class="d"></span><span class="lb">${esc(sum.label)}</span>` +
    (sum.behind ? `<span class="k">${esc(sum.behind)}</span>` : "") +
    `<span class="chev">▾</span></button>`;
  if (pop) {
    // The panel repaints every 5s while a run is live, and a wholesale innerHTML
    // swap resets the scroller to the top — read a family near the bottom of a
    // 47-row run and it would yank you back to the first one mid-read.
    const at = pop.querySelector(".fp-scroll")?.scrollTop ?? 0;
    pop.innerHTML = freshPopHtml(freshData);
    const scroller = pop.querySelector(".fp-scroll");
    if (scroller && at) scroller.scrollTop = at;
  }
  syncArmedTicker();
}

// While a refresh is armed the number has to fall on its own: the poll runs
// every 10s, and a countdown that jumps in ten-second steps reads as a stuck
// figure rather than as a wait. The tick is local and rewrites two text nodes
// — no request, and no innerHTML swap that would fight the open popover.
let armedTimer = null;
function syncArmedTicker() {
  const armed = freshData && freshData.armedAt;
  if (!armed) {
    if (armedTimer) clearInterval(armedTimer);
    armedTimer = null;
    return;
  }
  if (armedTimer) return;
  armedTimer = setInterval(() => {
    if (!freshData || !freshData.armedAt) {
      clearInterval(armedTimer);
      armedTimer = null;
      return;
    }
    const sum = freshSummary(freshData);
    const lb = $("#freshness .fresh-pill .lb");
    if (!lb) return;
    if (sum) lb.textContent = sum.label;
    const left = $("#fp-armed");
    if (left)
      left.textContent = `${Math.max(0, Math.ceil(freshData.armedAt - Date.now() / 1000))}s`;
  }, 1000);
}

// Fire-and-forget: freshness must never block or break the main state load.
async function loadFreshness() {
  if (freshnessPoll !== null) {
    clearTimeout(freshnessPoll);
    freshnessPoll = null;
  }
  const r = await api("/api/graph-freshness");
  freshData = r.ok ? r.data : null;
  updateFreshness();
  invalidateGraphIfRebuilt();
  const delay = freshPollDelay(freshData);
  if (delay !== null) freshnessPoll = setTimeout(loadFreshness, delay);
}

// Resolves true when the vault was read, false when it could not be — the
// explicit refresh reports which, the mutation call sites ignore it.
async function loadState() {
  const r = await api("/api/state");
  if (!r.ok) {
    toast(r.data.error || "failed to load state");
    return false;
  }
  lastStateAt = Date.now();
  state = r.data;
  if (!sources.length) await loadSources();
  // Drop selections whose skill vanished (renamed/archived) so bulk ops never
  // target a ghost.
  const live = new Set([
    ...(state.skills || []).map((s) => s.name),
    ...(state.archived || []).map((s) => s.name),
  ]);
  for (const n of [...libSel]) if (!live.has(n)) libSel.delete(n);
  $("#vault").textContent =
    `${state.vaultDir.replace(/^.*\//, "~/")} · ${state.skills.length} skills`;
  loadFreshness(); // fire-and-forget; must never block the state render
  sync = (await api("/api/sync")).data;
  if (state.skills.length === 0) {
    curView = "empty";
    render();
    return true;
  }
  render();
  refreshSyncLive();
  return true;
}
// The refresh button and r are the one read the user asks for, so unlike the
// reloads that trail a write, this one reports itself: the icon spins while it
// reads, then a toast says what came back.
async function doRefresh() {
  const b = $("#refresh");
  if (b && b.classList.contains("spin")) return; // already reading
  b?.classList.add("spin");
  // Refresh means "read the vault again", and the graph is part of what the
  // library shows. Without this the button re-read everything except the map,
  // and a stale or empty graph could only be cleared by reloading the page.
  graphData = null;
  graphAt = 0;
  const ok = await loadState();
  b?.classList.remove("spin");
  if (ok)
    toast(
      `Vault refreshed · ${(state.skills || []).length} skill${(state.skills || []).length === 1 ? "" : "s"}`,
    );
}
// Once per boot, refresh the sync counters against the LIVE remote
// (git fetch) so "to pull" reflects GitHub, not the last fetch. Runs
// after the first paint; re-renders the library only if the numbers
// changed (the banner appears or updates).
// Status re-checks against the live remote each time it opens: paint
// with cached counters, then re-render once if the fetch changed them.
let statusSyncStamp = 0;
async function refreshStatusSyncLive() {
  const stamp = ++statusSyncStamp;
  const r = await api("/api/sync?fetch=1");
  if (!r.ok || stamp !== statusSyncStamp) return;
  const changed = JSON.stringify(r.data) !== JSON.stringify(sync);
  sync = r.data;
  // Counters moved: the per-skill state (matrix, sync column) is stale
  // too, so reload everything, not just this pane.
  if (changed && curView === "status") loadState();
}
let syncLiveDone = false;
async function refreshSyncLive() {
  if (syncLiveDone) return;
  syncLiveDone = true;
  const before = JSON.stringify([sync?.dirty, sync?.ahead, sync?.behind]);
  const r = await api("/api/sync?fetch=1");
  if (!r.ok) return;
  sync = r.data;
  const after = JSON.stringify([sync.dirty, sync.ahead, sync.behind]);
  // Counters moved since the page painted: the per-skill Sync column is
  // built from /api/state, so a banner-only refresh would disagree with
  // the table. Reload the whole state instead.
  if (before !== after) loadState();
}
// Agents edit the vault while the tab sits in the background: on return,
// revalidate a stale snapshot so banner, table and Status agree.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && lastStateAt && Date.now() - lastStateAt > 60000)
    loadState();
});
// Position the freshness popover under its pill on open (native popover renders
// in the top layer, so it needs viewport coordinates), and wire the copy button.
{
  const fp = $("#fresh-pop");
  if (fp) {
    fp.addEventListener("toggle", (e) => {
      if (e.newState !== "open") {
        // A reopened panel starts folded: the expansion was an answer to "what
        // ran?", and carrying it into the next look (or the next run) keeps the
        // list long for no one.
        freshDoneOpen = false;
        return;
      }
      const btn = $("#freshness .fresh-pill");
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      fp.style.left =
        Math.round(Math.max(8, Math.min(r.left, window.innerWidth - 352))) +
        "px";
      fp.style.top = Math.round(r.bottom + 8) + "px";
      // Bound the panel to what is left of the viewport below the pill; the
      // family list inside it scrolls. A run of 47 families is otherwise taller
      // than the screen with no way to reach the bottom of it.
      fp.style.maxHeight =
        Math.max(220, Math.round(window.innerHeight - r.bottom - 20)) + "px";
    });
    fp.addEventListener("click", (e) => {
      const b = e.target.closest(".fresh-copy");
      if (b) copyText(b.getAttribute("data-cmd") || "");
      if (e.target.closest("[data-fresh-done]")) {
        freshDoneOpen = !freshDoneOpen;
        updateFreshness();
      }
    });
  }
}
initTheme();
loadGroupAxis();
loadLibView();
loadStatusFilter();
loadState();
