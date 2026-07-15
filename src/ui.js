const $ = (s) => document.querySelector(s);
const app = () => document.getElementById("app");
let state = null,
  sync = null;
let curView = "skills",
  current = null;
let currentFile = null,
  currentFileData = null,
  viewMode = "rendered";

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
// Collects a rename pattern transform for a multi-select. Resolves to
// { op, value } | { op, from, to } or null on cancel. The label of the first
// field and the visibility of the second track the chosen op.
function renameTransformDialog(count) {
  return new Promise((resolve) => {
    const dlg = $("#renamebulk"),
      op = $("#rb-op"),
      a = $("#rb-a"),
      b = $("#rb-b"),
      labelA = $("#rb-label-a"),
      rowB = $("#rb-row-b"),
      yes = $("#renamebulk-yes"),
      no = $("#renamebulk-no");
    $("#renamebulk-title").textContent = `Rename ${count} skills`;
    a.value = "";
    b.value = "";
    const sync = () => {
      const isReplace = op.value === "replace";
      labelA.textContent = isReplace
        ? "Find"
        : op.value === "strip-prefix"
          ? "Prefix to strip"
          : "Prefix";
      rowB.hidden = !isReplace;
    };
    op.value = "add-prefix";
    sync();
    const done = (v) => {
      op.removeEventListener("change", sync);
      yes.removeEventListener("click", oy);
      no.removeEventListener("click", on);
      dlg.removeEventListener("close", oc);
      dlg.close();
      resolve(v);
    };
    const oy = () => {
      if (op.value === "replace")
        done({ op: "replace", from: a.value, to: b.value });
      else done({ op: op.value, value: a.value });
    };
    const on = () => done(null);
    // "close" fires as a queued task; see promptDialog for why we gate
    // on dlg.open (only a genuine Esc/backdrop dismissal has it false).
    const oc = () => {
      if (!dlg.open) done(null);
    };
    op.addEventListener("change", sync);
    yes.addEventListener("click", oy);
    no.addEventListener("click", on);
    dlg.addEventListener("close", oc);
    dlg.showModal();
    a.focus();
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
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
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
// / red 25). Drives the domain/layer accents via taxHueStyle.
const TAX_HUES = [212, 235, 260, 285, 305, 328, 348, 192];
function hueHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
// Taxonomy hue: rank-based over the axis's distinct values (sorted), so up
// to 8 values per axis get 8 DIFFERENT hues (hashing collides). The stride
// (3, coprime with 8) spreads alphabetically-adjacent values far apart on
// the wheel. Same value gets the same hue as a section header and as a
// card chip. Falls back to the hash for unknown/empty values.
function taxHueStyle(axis, value) {
  const vals = [
    ...new Set((state.skills || []).map((s) => s[axis]).filter(Boolean)),
  ].sort();
  const i = vals.indexOf(value);
  const hue =
    i >= 0
      ? TAX_HUES[(i * 3) % TAX_HUES.length]
      : TAX_HUES[hueHash(value || "other") % TAX_HUES.length];
  return `--tint:oklch(59% 0.135 ${hue});--tint-soft:oklch(59% 0.135 ${hue} / 0.16)`;
}
// Single source of truth for library grouping + order. renderLibrary and
// libraryOrder (detail arrow-nav) BOTH consume this, so they cannot drift.
function groupKeyOf(s) {
  if (groupAxis === "layer") return s.layer || "";
  if (groupAxis === "domain") return s.domain || "";
  return "";
}
// The axis you are NOT grouping by (null in "none" mode).
function orthAxisOf() {
  return groupAxis === "domain"
    ? "layer"
    : groupAxis === "layer"
      ? "domain"
      : null;
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
// The free-text search haystack for a skill: title, name, description and both
// taxonomy axes, lowercased. Same fields the rendered data-hay attribute holds,
// so matchesSearch and filterLibrary's DOM check stay in lockstep.
function skillHay(s) {
  return (
    s.title +
    " " +
    s.name +
    " " +
    (s.description || "") +
    " " +
    (s.domain || "") +
    " " +
    (s.layer || "")
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
    (!domainFilter || s.domain === domainFilter) &&
    (!layerFilter || s.layer === layerFilter) &&
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
const NC_L = {
  100: 92,
  200: 86,
  300: 78,
  400: 70,
  500: 62,
  600: 54,
  700: 46,
  800: 38,
  900: 30,
};
const NC_C = {
  100: 0.4,
  200: 0.6,
  300: 0.8,
  400: 0.95,
  500: 1,
  600: 1,
  700: 0.9,
  800: 0.75,
  900: 0.6,
};
function namedColor(token) {
  if (!token) return null;
  const m = String(token)
    .trim()
    .toLowerCase()
    .match(/^([a-z]+)(?:-(\d{3}))?$/);
  if (!m) return null;
  const fam = m[1];
  const step = m[2] ? +m[2] : 500;
  const hue = NC_HUE[fam];
  if (hue === undefined || !(step in NC_L)) return null;
  const L = NC_L[step];
  const C = +((NC_NEUTRAL.has(fam) ? 0.014 : 0.15) * NC_C[step]).toFixed(3);
  return {
    c: `oklch(${L}% ${C} ${hue})`,
    soft: `oklch(${L}% ${C} ${hue} / 0.17)`,
  };
}
function skillTile(s) {
  const nm = (s.icon || "").trim();
  const col = namedColor(s.iconColor);
  const style = col ? ` style="--tint:${col.c};--tint-soft:${col.soft}"` : "";
  if (nm) {
    const inner = ICONS[nm] || ICONS.fallback;
    return `<span class="tile"${style}><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg></span>`;
  }
  const mono = ((s.name || "?").match(/[a-z0-9]/i) || ["?"])[0];
  return `<span class="tile mono"${style}>${esc(mono.toUpperCase())}</span>`;
}
// Small colored glyph for dense lists (rail sibling list) — no tile box.
function railIcon(s) {
  const nm = (s.icon || "").trim();
  const inner = nm ? ICONS[nm] || ICONS.fallback : ICONS.fallback;
  const col = namedColor(s.iconColor);
  // Colour only follows an explicit icon-color; otherwise the glyph uses
  // the neutral default (the vault is flat — no category tint).
  const style = col ? `color:${col.c}` : "";
  return `<span class="fic" style="${style}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg></span>`;
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
    return `<span class="badge ok">${CHECK}${esc(extra || "Active everywhere")}</span>`;
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
  // Rendered/Source persists while navigating between skills in the
  // detail view; it resets to Rendered when you re-enter from a list.
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
function render(arg) {
  const seq = ++navSeq;
  updateNav();
  // Skip the view fade on a same-view refresh (data reload): only the
  // content changes, the background stays put (no flash).
  app().classList.toggle("norefade", curView === lastView);
  lastView = curView;
  const isAsync =
    curView === "detail" || curView === "status" || curView === "config";
  if (isAsync) navStart();
  else navStop();
  if (curView === "skills")
    // An empty vault keeps the first-run hero on the My skills tab too,
    // not a bare empty table. Archived mode still renders its own list.
    (state.skills || []).length === 0 && !libArchived
      ? renderEmpty()
      : renderLibrary();
  else if (curView === "detail") renderDetail(arg || current, seq);
  else if (curView === "status") renderStatus(seq);
  else if (curView === "new") renderNew();
  else if (curView === "config") renderConfig(seq);
  else if (curView === "archived") renderArchived();
  else if (curView === "empty") renderEmpty();
}

/* ---------- library ---------- */
let searchQ = "";
let syncBannerDismissed = false;
let groupAxis = "none"; // "none" | "domain" | "layer"
let sortMode = "name"; // "name" | "axis" (orthogonal taxonomy axis) | "updated"
let sortDir = 1; // 1 asc, -1 desc (toggled by ledger column headers)
let libView = "list"; // "grid" | "list"
let libArchived = false; // library shows the archive instead of active skills
// The set the library renders: active vault skills, or archived ones as
// cards (same UI). All library machinery reads through this.
function libSkills() {
  return libArchived ? archivedCards() : state.skills || [];
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
let statusFilter = null; // null = all, else a status value
let domainFilter = null; // null = all, else a domain value
let layerFilter = null; // null = all, else a layer value
let linkFilter = null; // null = all, else a link state
let syncFilter = null; // null = all, else a sync state (internal value)
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
  const idx = els.findIndex((c) => c.dataset.skill === libSelName);
  let ni;
  if (idx < 0) {
    ni = 0;
  } else if (libView === "list") {
    const step = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
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
  draft: "acc",
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
// Colored via taxHueStyle (rank-based per axis), so each domain/layer value
// reads with its own hue at a glance and matches its section accent.
function taxChip(axis, v) {
  return `<span class="taxchip" style="${taxHueStyle(axis, v)}"><span class="tcdot"></span>${esc(humanTax(v))}</span>`;
}
// Orthogonal axis chip(s): the axis you are NOT grouping by. "none" shows both.
function orthChips(s) {
  const out = [];
  if ((groupAxis === "domain" || groupAxis === "none") && s.layer)
    out.push(taxChip("layer", s.layer));
  if ((groupAxis === "layer" || groupAxis === "none") && s.domain)
    out.push(taxChip("domain", s.domain));
  return out.join("");
}
function libCard(s) {
  const hay = skillHay(s);
  const chips = orthChips(s);
  const badges = statusBadge(s.status);
  const foot =
    chips || badges
      ? `<div class="foot"><span class="foot-l">${chips}</span><span class="foot-r">${badges}</span></div>`
      : "";
  return `<a class="card${libSel.has(s.name) ? " sel" : ""}" data-skill="${esc(s.name)}" data-hay="${esc(hay)}" data-domain="${esc(s.domain || "")}" data-layer="${esc(s.layer || "")}" data-status="${esc(s.status || "active")}" data-link="${esc(linkStateOf(s))}" data-sync="${esc(s.sync || "clean")}"><span class="selbox" aria-hidden="true"></span><div class="top">${skillTile(s)}<div class="headwrap"><h3>${esc(s.title)}</h3></div><span class="when">${esc(fmtWhen(s.modified))}</span></div><p>${esc(s.description || "No description yet.")}</p>${foot}</a>`;
}
// Command rail: Group switch + Domain / Layer / Status lists with counts.
// Counts are a snapshot of the whole vault, not of the current filter.
const STATUS_ORDER = ["idea", "draft", "active", "suspended", "deprecated"];
const STATUS_DOT = {
  idea: "var(--faint)",
  draft: "var(--accent)",
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
    `<button data-axis="${a}"${groupAxis === a ? ' class="on"' : ""} type="button">${lbl}</button>`;
  const item = (kind, v, label, count, on, style) =>
    `<button class="ritem${on ? " on" : ""}" data-kind="${kind}" data-v="${esc(v)}" style="${style}" type="button"><span class="d"></span>${esc(label)}<span class="n">${count}</span></button>`;
  const dc = counts("domain");
  const lc = counts("layer");
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
  return (
    `<div class="rl">Group by</div><div class="seg" id="groupby">${seg("none", "None")}${seg("domain", "Domain")}${seg("layer", "Layer")}</div>` +
    `<div class="rl">Domain</div>` +
    axisValues("domain")
      .map((v) =>
        item(
          "domain",
          v,
          humanTax(v),
          dc[v],
          domainFilter === v,
          taxHueStyle("domain", v),
        ),
      )
      .join("") +
    `<div class="rl">Layer</div>` +
    axisValues("layer")
      .map((v) =>
        item(
          "layer",
          v,
          humanTax(v),
          lc[v],
          layerFilter === v,
          taxHueStyle("layer", v),
        ),
      )
      .join("") +
    `<div class="rl">Status</div>` +
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
      .join("") +
    `<div class="rl">Links</div>` +
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
      .join("") +
    `<div class="rl">Sync</div>` +
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
      .join("")
  );
}
// Per-skill link summary from the runtime matrix, in the same words as
// the Status legend: linked / partial / not linked / conflict.
function linkStateOf(s) {
  const states = (state.matrix || [])
    .filter((m) => m.skill === s.name)
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
// Ledger (list view): one row per skill, a tbody per group so filtering
// can hide whole groups; column headers write sortMode/sortDir, which
// groupedSkills() consumes — table order and arrow-nav stay in step.
function renderTableHtml() {
  const orth = orthAxisOf();
  const axisCols = groupAxis === "none" ? ["domain", "layer"] : [orth];
  const arrow = (c) =>
    sortMode === c ? `<span class="arr">${sortDir > 0 ? "▲" : "▼"}</span>` : "";
  const head =
    `<thead><tr><th class="selcol"></th><th data-sort="name" style="width:19%">Skill ${arrow("name")}</th><th>Description</th>` +
    axisCols
      .map(
        (a) =>
          `<th style="width:11%">${a === "layer" ? "Layer" : "Domain"}</th>`,
      )
      .join("") +
    `<th style="width:9%">Status</th><th style="width:9%">Links</th><th style="width:9%">Sync</th><th data-sort="updated" style="width:10%">Updated ${arrow("updated")}</th></tr></thead>`;
  const bodies = groupedSkills()
    .map((g) => {
      const secRow =
        groupAxis === "none"
          ? ""
          : `<tr class="lsec"><td colspan="${7 + axisCols.length}"><span class="lsechead" style="${taxHueStyle(groupAxis, g.key)}"><span class="catdot"></span><h2>${esc(g.label)}</h2><span class="n">${g.items.length} skill${g.items.length === 1 ? "" : "s"}</span></span></td></tr>`;
      const rows = g.items
        .map((s) => {
          const hay = skillHay(s);
          const cells = axisCols
            .map((a) =>
              s[a]
                ? `<td>${taxChip(a, s[a])}</td>`
                : `<td class="lnone">–</td>`,
            )
            .join("");
          return `<tr class="${libSel.has(s.name) ? "sel" : ""}" data-skill="${esc(s.name)}" data-hay="${esc(hay)}" data-domain="${esc(s.domain || "")}" data-layer="${esc(s.layer || "")}" data-status="${esc(s.status || "active")}" data-link="${esc(linkStateOf(s))}" data-sync="${esc(s.sync || "clean")}"><td class="selcol"><span class="selbox" aria-hidden="true"></span></td><td><span class="lname">${skillTile(s)}${esc(s.title)}</span></td><td class="ldesc">${esc(s.description || "")}</td>${cells}<td>${statusBadge(s.status, true)}</td><td>${linkCell(s)}</td><td>${syncCell(s.sync)}</td><td class="lwhen">${esc(fmtWhen(s.modified))}</td></tr>`;
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
function renderLibrary() {
  const consumers = listJoin(Object.keys(state.consumers).map(rtName));
  const total = libSkills().length;
  let groupsHtml = "";
  if (libView === "list") {
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
  const LIST_IC =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.5" cy="4" r="0.8" fill="currentColor" stroke="none"/><circle cx="2.5" cy="8" r="0.8" fill="currentColor" stroke="none"/><circle cx="2.5" cy="12" r="0.8" fill="currentColor" stroke="none"/></svg>';
  setFixed(true);
  app().innerHTML = `<div class="liblayout">
          <aside class="librail" id="librail">${renderRailHtml()}</aside>
          <main class="libmain">
            <div class="libhead"><div><h1 class="view">${libArchived ? "Archived skills" : "Your skill library"}</h1><p class="sub">${libArchived ? `${total} skill${total === 1 ? "" : "s"} retired from every runtime. Open one to read it, then Restore to bring it back.` : `${total} skill${total === 1 ? "" : "s"}${consumers ? `, shared with ${esc(consumers)}` : ""}. <span id="syncnote"></span>`}</p></div>${libArchived ? "" : '<button class="new" data-go="new">+ New skill</button>'}</div>
            ${syncBannerHtml()}
            <div class="libbar">
              <div class="search">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5.2" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3.4 3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                <input id="search" placeholder="Search your skills…" value="${esc(searchQ)}" />
              </div>
              <div class="seg" id="viewtoggle"><button data-view="grid"${libView === "grid" ? ' class="on"' : ""} type="button" aria-label="Grid view">${GRID_IC}</button><button data-view="list"${libView === "list" ? ' class="on"' : ""} type="button" aria-label="List view">${LIST_IC}</button></div>
            </div>
            <div id="groups">${groupsHtml}</div>
            <div id="noresult" class="empty" hidden></div>
            ${libArchived ? `<button class="archivedlink" id="back-active">← Active skills</button>` : archived.length ? `<button class="archivedlink" data-go="archived">Archived skills (${archived.length}) →</button>` : ""}
          </main>
        </div>`;
  $("#search").addEventListener("input", (e) => {
    searchQ = e.target.value;
    filterLibrary();
  });
  $("#back-active")?.addEventListener("click", () => {
    libArchived = false;
    go("skills");
  });
  if ($("#syncnow")) $("#syncnow").addEventListener("click", doSaveSync);
  if ($("#syncdismiss"))
    $("#syncdismiss").addEventListener("click", () => {
      syncBannerDismissed = true;
      renderLibrary();
    });
  $("#librail").addEventListener("click", (e) => {
    const g = e.target.closest("#groupby button");
    if (g) {
      groupAxis = g.dataset.axis;
      renderLibrary();
      return;
    }
    const b = e.target.closest(".ritem");
    if (!b) return;
    const v = b.dataset.v;
    if (b.dataset.kind === "domain")
      domainFilter = domainFilter === v ? null : v;
    else if (b.dataset.kind === "layer")
      layerFilter = layerFilter === v ? null : v;
    else if (b.dataset.kind === "link")
      linkFilter = linkFilter === v ? null : v;
    else if (b.dataset.kind === "sync")
      syncFilter = syncFilter === v ? null : v;
    else statusFilter = statusFilter === v ? null : v;
    $("#librail").innerHTML = renderRailHtml();
    filterLibrary();
  });
  $("#viewtoggle").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.dataset.view === libView) return;
    libView = b.dataset.view;
    if (libView === "grid" && sortMode === "updated") {
      sortMode = "name";
      sortDir = 1;
    }
    renderLibrary();
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
      renderLibrary();
    });
  filterLibrary();
  if (libSelName) libHighlight(libSelName);
  libSelApply();
  renderSyncNote();
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
        const okDomain = !domainFilter || c.dataset.domain === domainFilter;
        const okLayer = !layerFilter || c.dataset.layer === layerFilter;
        const okLink = !linkFilter || c.dataset.link === linkFilter;
        const okSync = !syncFilter || c.dataset.sync === syncFilter;
        const hit =
          okSearch && okStatus && okDomain && okLayer && okLink && okSync;
        c.hidden = !hit;
        if (hit) vis = true;
      });
      sec.hidden = !vis;
      if (vis) anyVisible = true;
    });
  const filtering = !!(
    q ||
    statusFilter ||
    domainFilter ||
    layerFilter ||
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
async function renderSyncNote() {
  sync = (await api("/api/sync")).data;
  const el = $("#syncnote");
  if (!el) return;
  if (!sync.versioned || !sync.remote) {
    el.textContent = "";
    return;
  }
  if (sync.dirty === 0 && sync.ahead === 0 && sync.behind === 0)
    el.innerHTML = "<b>Everything is in sync.</b>";
  else
    el.innerHTML = `<a data-go="status" style="color:var(--accent);font-weight:600;cursor:pointer">Changes to sync →</a>`;
}

/* ---------- detail (three-pane) ---------- */
// Last skill opened in detail — lets the "My skills" tab restore the
// detail after visiting Status/Config (cleared on "← Your library").
let lastDetail = null;
function goSkillsTab() {
  libArchived = false; // the My skills tab always lands on active skills
  if (lastDetail && (state.skills || []).some((s) => s.name === lastDetail))
    go("detail", lastDetail);
  else go("skills");
}
async function renderDetail(name, seq) {
  current = name;
  lastDetail = name;
  libSelName = name;
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
  const fileRow = (f, ind) => {
    const nm = f.path.slice(f.path.lastIndexOf("/") + 1);
    const sel = f.path === (currentFile || "SKILL.md") ? " sel" : "";
    return `<div class="file${sel}" data-file="${esc(f.path)}" title="${esc(f.path)}"><span class="fic">${fileIcon(f.path)}</span><span class="fname">${esc(nm)}</span></div>`;
  };
  const _guide = d.files.filter((f) => f.path === "SKILL.md");
  const _rest = d.files.filter((f) => f.path !== "SKILL.md");
  const _dirs = {};
  _rest
    .filter((f) => f.path.includes("/"))
    .forEach((f) => {
      const dn = f.path.slice(0, f.path.indexOf("/"));
      (_dirs[dn] = _dirs[dn] || []).push(f);
    });
  const _roots = _rest
    .filter((f) => !f.path.includes("/"))
    .sort((a, b) => a.path.localeCompare(b.path));
  // Root files (SKILL.md + any loose files like requirements.txt) live
  // together under the "Files" header; folder groups follow. Root files
  // must NOT trail the folder groups or they read as part of the last one.
  let filesHtml = _guide.map((f) => fileRow(f, false)).join("");
  filesHtml += _roots.map((f) => fileRow(f, false)).join("");
  Object.keys(_dirs)
    .sort()
    .forEach((dn) => {
      filesHtml += `<div class="flabel">${esc(dn)}</div>`;
      _dirs[dn]
        .sort((a, b) => a.path.localeCompare(b.path))
        .forEach((f) => {
          filesHtml += fileRow(f, true);
        });
    });
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
  setFixed(true);
  navStop();
  app().innerHTML = `<div class="layout">
          <aside class="rail">
            <button class="crumb" data-go="skills">← Your library</button>
            <div class="railtop">
              <p class="railh">Files</p>
              <div id="filelist">${filesHtml}</div>
            </div>
            ${sibHtml}
          </aside>
          <main class="doc review">
            <div class="dochead">
              ${skillTile(summary)}
              <h1>${esc(summary.title || d.name)}</h1>
              ${arch ? '<span class="badge off">Archived</span>' : healthBadge(summary.health || "inactive", summary.health === "active" ? "Active everywhere" : undefined)}
              <span class="acts">${arch ? '<button class="btn primary" id="d-restore">Restore</button>' : '<button class="btn" id="d-rename">Rename</button><button class="btn danger" id="d-archive">Archive</button>'}</span>
            </div>
            <div class="descmeta"><span>updated ${esc(fmtWhen(summary.modified || ""))}</span></div>
            ${arch ? "" : detMetaHtml(summary)}
            ${d.description ? `<p class="desc">${esc(d.description)}</p>` : ""}
            ${arch ? "" : skillMetaHtml(d.frontmatter)}
            ${arch && d.reason ? `<p class="desc" style="color:var(--dim)"><b>Archived:</b> ${esc(d.reason)}</p>` : ""}
            <div class="viewerbar" id="viewerbar"><span class="fname" id="fname"></span><span class="seg vhide" id="seg"><b data-mode="rendered">Rendered</b><span data-mode="source">Source</span></span></div>
            <div id="viewer"></div>
          </main>
          <aside class="meta">
            <div class="sect"><p class="railh" style="padding:0 0 8px">Active on</p>${arch ? '<p class="rmeta">Archived — not on any runtime.</p>' : togglesHtml}</div>
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
    $("#d-rename")?.addEventListener("click", () => doRename(name));
    $("#d-archive")?.addEventListener("click", () => doArchive(name));
  }
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
async function selectFile(p) {
  currentFile = p;
  const vb = $("#viewerbar");
  if (vb) vb.hidden = false;
  const hb = $("#hist-back");
  if (hb) hb.hidden = true;
  document
    .querySelectorAll("#history .commit")
    .forEach((c) => c.classList.remove("sel"));
  document.querySelectorAll("#filelist .file").forEach((b) => {
    const on = b.dataset.file === p;
    b.classList.toggle("sel", on);
    if (on) b.scrollIntoView({ block: "nearest" });
  });
  $("#fname").textContent = p;
  // Scope the history rail to this file (git log of the file, not the
  // whole skill), so selecting live-state.md shows live-state.md's history.
  renderHistory(current, p);
  const r = await api(
    `/api/file?name=${encodeURIComponent(current)}&path=${encodeURIComponent(p)}`,
  );
  if (!r.ok) {
    $("#viewer").innerHTML =
      `<div class="empty">${esc(r.data.error || "cannot read file")}</div>`;
    $("#seg").classList.add("vhide");
    return;
  }
  currentFileData = r.data;
  const isMd = /\.(md|markdown)$/i.test(p) && r.data.kind === "text";
  $("#seg").classList.toggle("vhide", !isMd);
  if (isMd) setMode(viewMode);
  else renderPlain();
  scrollViewerTop();
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
    const skillTitle =
      (
        (state.skills || []).find((s) => s.name === current) ||
        (state.archived || []).find((s) => s.name === current) ||
        {}
      ).title || current;
    $("#viewer").innerHTML =
      `<article class="md doc">${renderMd(currentFileData.content, currentFile !== "SKILL.md", currentFile, skillTitle)}</article>`;
  } else renderPlain();
}
function renderPlain() {
  const d = currentFileData;
  if (d.kind === "image") {
    $("#viewer").innerHTML =
      `<img class="preview" style="max-width:100%;border:1px solid var(--line);border-radius:9px" src="${esc(d.content)}" alt="">`;
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
  if (hf) hf.textContent = filePath && filePath !== "SKILL.md" ? filePath : "";
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
  $("#viewer").innerHTML = `<pre class="plain">${colorDiff(r.data.diff)}</pre>`;
  const back = $("#hist-back");
  if (back) {
    back.textContent = `← Back to ${currentFile || "SKILL.md"}`;
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

  // coverage table
  let cov = `<tr><th>Skill</th>${consumers.map((c) => `<th>${esc(rtName(c))}</th>`).join("")}<th>Updated</th></tr>`;
  for (const s of state.skills) {
    cov +=
      `<tr><td class="mono">${esc(s.name)}</td>` +
      consumers
        .map((c) => {
          const cell = state.matrix.find(
            (m) => m.skill === s.name && m.consumer === c,
          );
          // Suspended skills aren't in the matrix (they don't count toward
          // health), but their coverage is deterministic: an in-place
          // consumer still serves them from the vault; a symlink consumer
          // doesn't link them. Show that honestly instead of a bare "?".
          const cv = state.consumers[c];
          const isInplace =
            cv && typeof cv === "object" && cv.mode === "in-place";
          const st = cell ? cell.state : isInplace ? "served" : "missing";
          const cls =
            st === "linked" || st === "served"
              ? "ok"
              : st === "missing"
                ? "off"
                : "bad";
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
        .join("") +
      `<td class="awhen">${esc(fmtWhen(s.modified))}</td></tr>`;
  }

  // taxonomy health
  const statusCounts = {};
  for (const s of state.skills) {
    const k = s.status || "active";
    statusCounts[k] = (statusCounts[k] || 0) + 1;
  }
  const untagged = state.skills.filter((s) => !s.domain || !s.layer);
  const statusRows = Object.keys(statusCounts)
    .sort()
    .map(
      (k) =>
        `<tr><td class="mono">${esc(k)}</td><td class="awhen">${statusCounts[k]} skill${statusCounts[k] === 1 ? "" : "s"}</td></tr>`,
    )
    .join("");
  const taxHtml = `<section class="coverage"><div class="covhead"><h2>Taxonomy</h2><span class="cnt">${state.skills.length} skills · by lifecycle status</span></div><table class="grid"><tr><th>Status</th><th>Count</th></tr>${statusRows}</table>${untagged.length ? `<div class="taxmiss"><span class="badge warn">Missing taxonomy</span> ${untagged.length} skill${untagged.length === 1 ? "" : "s"} without domain or layer: ${untagged.map((s) => `<span class="mono">${esc(s.name)}</span>`).join(", ")}</div>` : ""}</section>`;

  // hygiene findings — advisory (H1 drift, machine paths, opt-in lint)
  const KIND_WORD = {
    "h1-mismatch": "H1 ≠ name",
    "absolute-path": "machine path",
    "description-length": "description too long",
    "body-length": "body too long",
    "missing-section": "missing section",
    "missing-taxonomy": "missing taxonomy",
    "unknown-domain": "unknown domain",
    "unknown-layer": "unknown layer",
  };
  const warnings = state.warnings || [];
  const hygieneHtml = warnings.length
    ? `<section class="coverage"><div class="covhead"><h2>Hygiene</h2><span class="cnt">${warnings.length} advisory finding${warnings.length === 1 ? "" : "s"} · never block linking</span></div><table class="grid"><tr><th>Skill</th><th>Finding</th><th>Detail</th></tr>${warnings
        .map(
          (w) =>
            `<tr><td class="mono">${esc(w.name)}</td><td><span class="badge warn">${esc(KIND_WORD[w.kind] || w.kind)}</span></td><td class="awhen">${esc(w.detail)}</td></tr>`,
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
            <section class="coverage"><div class="covhead"><h2>Runtime coverage</h2><span class="cnt">${state.skills.length} skills · ${listJoin(consumers.map(rtName))}</span></div><p class="covlegend"><b>linked</b> symlink to the vault · <b>not linked</b> nothing installed at the runtime path · <b>conflict</b> something that is not the vault's link owns that path; skill-loom never overwrites it</p><table class="grid">${cov}</table></section>
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
    return go("status");
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
  go("status");
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
    'Word to re-case (one kebab segment, e.g. "forpros"):',
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
  // The form mirrors the vault's rules (loom.json lint): show and require
  // the taxonomy the vault demands, populate dropdowns from its allowed
  // values, and scaffold the sections it requires — so a new skill is born
  // gate-ready. A vault with no lint gets the plain name + description form.
  const lint = state.lint || null;
  const req = (lint && lint.requireTaxonomy) || [];
  const domains = (lint && lint.allowedDomains) || [];
  const layers = (lint && lint.allowedLayers) || [];
  const needsDomain = req.includes("domain");
  const needsLayer = req.includes("layer");
  const showDomain = needsDomain || domains.length > 0;
  const showLayer = needsLayer || layers.length > 0;
  const showTaxo = showDomain || showLayer;
  const sections = (lint && lint.requireSections) || [];
  const minChars = lint && lint.descriptionMinChars;
  const selField = (id, label, values, required, hint) =>
    `<div class="field-row"><label class="field" for="${id}">${label}${required ? ' <span class="req">required</span>' : ""}</label>` +
    (values.length
      ? `<select class="txt" id="${id}"${required ? " required" : ""}><option value="">(choose)</option>${values.map((v) => `<option>${esc(v)}</option>`).join("")}</select>`
      : `<input class="txt" id="${id}"${required ? " required" : ""} spellcheck="false" placeholder="${esc(label.toLowerCase())}" />`) +
    `<p class="hint">${hint}</p></div>`;
  const domainRow = showDomain
    ? selField(
        "n-domain",
        "Domain",
        domains,
        needsDomain,
        "Who the skill belongs to: a brand, a project.",
      )
    : "";
  const layerRow = showLayer
    ? selField(
        "n-layer",
        "Layer",
        layers,
        needsLayer,
        "What kind of work it does.",
      )
    : "";
  const statusRow = showTaxo
    ? `<div class="field-row"><label class="field" for="n-status">Status</label><select class="txt" id="n-status">${STATUS_ORDER.map((v) => `<option value="${esc(v)}"${v === "draft" ? " selected" : ""}>${esc(statusLabel(v))}</option>`).join("")}</select><p class="hint">Lifecycle. New skills start as a draft.</p></div>`
    : "";
  app().innerHTML = `<div class="newwrap">
          <button class="crumb" data-go="skills">← Your library</button>
          <h1>Create a new skill</h1>
          <p class="sub" style="max-width:68ch">It becomes one canonical folder in your vault, versioned in git and linked into every runtime. No copies to keep in sync by hand.</p>
          <div class="newgrid">
            <form id="newform">
              <div class="field-row"><label class="field" for="n-name">Name</label><input class="txt" id="n-name" placeholder="ai-act-readiness" pattern="[a-z0-9][a-z0-9-]*" spellcheck="false" required /><p class="hint">Lowercase, words joined by dashes. Folder name and the id agents match on. <span class="mono" id="n-slug"></span></p></div>
              ${domainRow}${layerRow}${statusRow}
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
    const domain = $("#n-domain") ? $("#n-domain").value.trim() : "";
    const layer = $("#n-layer") ? $("#n-layer").value.trim() : "";
    const status = $("#n-status") ? $("#n-status").value : "draft";
    $("#n-slug").textContent = name;
    $("#n-tree").innerHTML =
      `skills-vault/\n└─ <span class="accent">${esc(name)}/</span>\n   └─ SKILL.md`;
    let fm =
      `<span class="k">---</span>\n` +
      `<span class="k">name:</span> ${esc(name)}\n` +
      `<span class="k">description:</span> ${esc(desc || "…")}\n`;
    if (showDomain)
      fm += `<span class="k">domain:</span> ${esc(domain || "…")}\n`;
    if (showLayer) fm += `<span class="k">layer:</span> ${esc(layer || "…")}\n`;
    if (showTaxo)
      fm += `<span class="k">status:</span> ${esc(status || "draft")}\n`;
    else fm += `<span class="c"># optional: domain / layer / status</span>\n`;
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
  const body = {
    name: $("#n-name").value.trim(),
    description: $("#n-desc").value.trim() || undefined,
    domain: $("#n-domain")
      ? $("#n-domain").value.trim() || undefined
      : undefined,
    layer: $("#n-layer") ? $("#n-layer").value.trim() || undefined : undefined,
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

  const chipList = (field, opts) => {
    const mono = opts && opts.mono;
    const display = (opts && opts.display) || ((v) => v);
    const values = d[field] || [];
    return (
      values
        .map(
          (v) =>
            `<span class="chip rm${mono ? " code" : ""}">${esc(display(v))} <button type="button" class="x" data-rules-chip-rm="${field}" data-rules-chip-value="${esc(v)}">×</button></span>`,
        )
        .join("") +
      `<input class="chip add" type="text" placeholder="+ add" spellcheck="false" data-rules-chip-add="${field}" />`
    );
  };

  const rxRows = (d.forbidBodyPatterns || [])
    .map((v, i) => {
      const bad = !isValidRegex(v);
      return (
        `<div class="rxrow${bad ? " rxbad" : ""}"><input class="rxinput" type="text" value="${esc(v)}" spellcheck="false" data-rules-rx-i="${i}" /><button type="button" class="x" data-rules-rx-rm="${i}">×</button></div>` +
        (bad ? `<div class="rxerr">invalid regex, cannot save</div>` : "")
      );
    })
    .join("");
  const addBad = !isValidRegex(rulesPatternAdd);
  const rxAddRow =
    `<div class="rxrow add${addBad ? " rxbad" : ""}"><input class="rxinput" type="text" placeholder="+ add pattern" spellcheck="false" value="${esc(rulesPatternAdd)}" data-rules-rx-add /></div>` +
    (addBad ? `<div class="rxerr">invalid regex, cannot save</div>` : "");

  const strictOn = d.strict === true;

  return `<div class="panel" id="rules-panel">
          <div class="panel-h"><h2>Rules</h2><p>What every skill must satisfy. Saving rewrites the lint block in loom.json and re-arms the gate.</p></div>
          <div class="edscroll">
            <div class="edrow"><div class="edk">Required taxonomy<span class="k2">Axes every skill must declare</span></div><div class="edv">${taxoRow}</div></div>
            <div class="edrow"><div class="edk">Allowed domains<span class="k2">Frontmatter domain must be one of these</span></div><div class="edv">${chipList("allowedDomains")}</div></div>
            <div class="edrow"><div class="edk">Allowed layers</div><div class="edv">${chipList("allowedLayers")}</div></div>
            <div class="edrow"><div class="edk">Required sections<span class="k2">Headings each SKILL.md must contain</span></div><div class="edv">${chipList("requireSections", { mono: true, display: (v) => "## " + v })}</div></div>
            <div class="edrow"><div class="edk">Description length</div><div class="edv">min <input class="num" type="text" inputmode="numeric" value="${d.descriptionMinChars ?? ""}" data-rules-num="descriptionMinChars" /> to max <input class="num" type="text" inputmode="numeric" value="${d.descriptionMaxChars ?? ""}" data-rules-num="descriptionMaxChars" /><span style="color:var(--faint);font-size:12.5px">characters</span></div></div>
            <div class="edrow"><div class="edk">Body max lines<span class="k2">SKILL.md body cap, waivable per skill</span></div><div class="edv"><input class="num" type="text" inputmode="numeric" value="${d.bodyMaxLines ?? ""}" data-rules-num="bodyMaxLines" /></div></div>
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
                (m) => m.consumer === rt.name,
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
  return (state.archived || []).map((x) => ({
    ...x,
    modified: x.date || "",
    status: x.status || "active",
    sync: "clean",
  }));
}
// Archive is just the library in archived mode — same rail, table, grid,
// search — so it renders through renderLibrary, not a separate view.
function renderArchived() {
  libArchived = true;
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
async function doArchive(name) {
  // No reason prompt: the archive is folder-based and the reason is no
  // longer surfaced. Just confirm the plan.
  const dry = await api("/api/archive", {
    name,
    reason: "",
    apply: false,
  });
  if (!dry.ok) return toast(dry.data.message || dry.data.error);
  if (!(await confirmActions(`Archive "${name}"?`, dry.data.actions))) return;
  const wet = await api("/api/archive", {
    name,
    reason: "",
    apply: true,
  });
  toast(wet.data.message || wet.data.error);
  await loadState();
  go("skills");
}
async function doRename(name) {
  const next = await promptDialog(`Rename "${name}" to:`, name, "Rename");
  if (!next || next === name) return;
  const dry = await api("/api/migrate", {
    old: name,
    new: next,
    apply: false,
  });
  if (!dry.ok) return toast(dry.data.message || dry.data.error);
  if (
    !(await confirmActions(`Rename "${name}" to "${next}"?`, dry.data.actions))
  )
    return;
  const wet = await api("/api/migrate", {
    old: name,
    new: next,
    apply: true,
  });
  toast(wet.data.message || wet.data.error);
  await loadState();
  if (wet.ok) go("detail", next);
  else go("detail", name);
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
  const domainVals = (
    state.lint && state.lint.allowedDomains.length
      ? state.lint.allowedDomains
      : axisValues("domain")
  ).map((v) => ({ v, label: humanTax(v) }));
  const layerVals = (
    state.lint && state.lint.allowedLayers.length
      ? state.lint.allowedLayers
      : axisValues("layer")
  ).map((v) => ({ v, label: humanTax(v) }));
  return (
    `<div class="ctxhd">${head}</div>` +
    (n === 1 ? `<button class="ctxitem" data-ctx="open">Open</button>` : "") +
    sub("Set status", "status", statusOpts) +
    (domainVals.length
      ? sub("Set domain", "domain", domainVals)
      : `<div class="ctxitem disabled">Set domain (none defined)</div>`) +
    (layerVals.length
      ? sub("Set layer", "layer", layerVals)
      : `<div class="ctxitem disabled">Set layer (none defined)</div>`) +
    `<button class="ctxitem" data-ctx="rename">Rename…</button>` +
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
  if (kind === "status")
    return bulkAction(
      "/api/bulk/status",
      { status: val },
      `Set status to "${statusLabel(val)}"?`,
    );
  if (kind === "domain")
    return bulkAction(
      "/api/bulk/taxonomy",
      { field: "domain", value: val },
      `Set domain to "${humanTax(val)}"?`,
    );
  if (kind === "layer")
    return bulkAction(
      "/api/bulk/taxonomy",
      { field: "layer", value: val },
      `Set layer to "${humanTax(val)}"?`,
    );
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
  if (kind === "rename") return bulkRename();
}
// Single target reuses the free-text prompt (nicer than a transform);
// 2+ targets collect a pattern transform and hit the bulk-rename route.
async function bulkRename() {
  const names = [...libSel];
  if (names.length === 1) return doRename(names[0]);
  const t = await renameTransformDialog(names.length);
  if (!t) return;
  return bulkAction(
    "/api/bulk/rename",
    { transform: t },
    "Rename these skills?",
  );
}

/* ---------- markdown (escaped-first minimal renderer) ---------- */
/* ── self-contained syntax highlighter (see highlighter.js) ── */
const LANG_BY_EXT = {
  py: "python",
  json: "json",
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

// VSCode-style colour chip: prepend a swatch to any #hex inside inline code.
function hexSw(s) {
  return s.replace(
    /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g,
    (h) => `<span class="hexsw" style="background:${h}"></span>${h}`,
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
            items.push(lm[2].trim().replace(/^["']|["']$/g, ""));
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
      rows.push([key, kv[2].replace(/^["']|["']$/g, "")]);
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
    return ` ${anchors.length - 1} `;
  });
  const linked = stashed.replace(/https?:\/\/[^\s<>"'`)\]]+/g, (u) => {
    const tail = (/[.,;:!?]+$/.exec(u) || [""])[0];
    const core = tail ? u.slice(0, -tail.length) : u;
    return `<a href="${core}" rel="noopener" target="_blank">${core}</a>${tail}`;
  });
  return linked.replace(/ (\d+) /g, (_, i) => anchors[+i]);
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
  const out = [];
  if (s.domain) out.push(taxChip("domain", s.domain));
  if (s.layer) out.push(taxChip("layer", s.layer));
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
// reads as part of the document. name/description/domain/layer/status live
// in the header and taxonomy chips already.
function skillMetaHtml(fm) {
  if (!fm) return "";
  const HIDE = new Set([
    "name",
    "description",
    "domain",
    "layer",
    "status",
    "icon",
    "icon-color",
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
function slugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
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
    linkifyBareUrls(
      s
        .replace(/`([^`]+)`/g, (m, c) => "<code>" + hexSw(c) + "</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, t, u) =>
          u.startsWith("#")
            ? // in-page anchor: scroll within the viewer, never a new tab/reload
              `<a href="${u}" class="docanchor">${t}</a>`
            : /^(https?:\/\/|\.|\/)/.test(u)
              ? `<a href="${u}" rel="noopener" target="_blank">${t}</a>`
              : all,
        ),
    );
  const lines = esc(text).split("\n");
  const rawLines = text.split("\n");
  let html = fm && showFm ? renderFrontmatterCard(fm, fmFile) : "";
  let inCode = false,
    codeLang = null,
    codeBuf = [],
    inList = null,
    firstH1 = true,
    para = [];
  const flushPara = () => {
    if (para.length) {
      html += `<p>${inline(para.join(" "))}</p>`;
      para = [];
    }
  };
  const flushList = () => {
    if (inList) {
      html += `</${inList}>`;
      inList = null;
    }
  };
  const splitRow = (row) => {
    const c = row.split("|");
    if (c.length && c[0].trim() === "") c.shift();
    if (c.length && c[c.length - 1].trim() === "") c.pop();
    return c.map((x) => x.trim());
  };
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.startsWith("```")) {
      if (!inCode) {
        flushPara();
        flushList();
        const fence = rawLines[li].slice(3).trim().toLowerCase();
        codeLang = LANG_BY_FENCE[fence.split(/\s+/)[0]] || null;
        codeBuf = [];
        inCode = true;
      } else {
        html += `<pre class="code"><code>${highlight(codeBuf.join("\n"), codeLang)}</code></pre>`;
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
        flushList();
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
      flushList();
      const lvl = h[1].length;
      const rawText = rawLines[li].replace(/^\s*#{1,6}\s+/, "");
      const id = headingId(rawText);
      const isFirstH1 = lvl === 1 && firstH1;
      if (isFirstH1) firstH1 = false;
      // On SKILL.md the first H1 is the skill slug (e.g. midas-brand-system);
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
    const ul = /^\s*[-*]\s+(.*)$/.exec(line),
      ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const want = ul ? "ul" : "ol";
      if (inList !== want) {
        flushList();
        html += `<${want}>`;
        inList = want;
      }
      const item = (ul ?? ol)[1];
      const task = ul && /^\[([ xX])\]\s+(.*)$/.exec(item);
      if (task) {
        html += `<li class="task${task[1].toLowerCase() === "x" ? " done" : ""}">${inline(task[2])}</li>`;
      } else {
        html += `<li>${inline(item)}</li>`;
      }
      continue;
    }
    if (/^\s*&gt;\s?/.test(line)) {
      flushPara();
      flushList();
      html += `<blockquote>${inline(line.replace(/^\s*&gt;\s?/, ""))}</blockquote>`;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara();
      flushList();
      html += "<hr>";
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  flushList();
  if (inCode)
    html += `<pre class="code"><code>${highlight(codeBuf.join("\n"), codeLang)}</code></pre>`;
  return html;
}

/* ---------- events + boot ---------- */
document.addEventListener("click", (e) => {
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
          "[data-go],[data-skill],[data-file],[data-mode],[data-hash-open],[data-toggle],[data-consumer],[data-inplace],[data-restore],[data-remote],[data-coming],[data-nameadd],[data-namedel],[data-runtimeadd],[data-runtimepreset]",
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
  } else if (t.dataset.skill) go("detail", t.dataset.skill);
  else if (t.dataset.file) selectFile(t.dataset.file);
  else if (t.dataset.mode) setMode(t.dataset.mode);
  else if (t.dataset.hashOpen) showCommit(t.dataset.hashOpen, t.dataset.subj);
  else if (t.dataset.toggle) toggleRuntime(t.dataset.toggle, t);
  else if (t.dataset.consumer) toggleConsumer(t.dataset.consumer, t);
  else if (t.dataset.inplace) toggleInplace(t.dataset.inplace, t);
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
  ["F", "Focus search"],
  ["1 · 2 · 3", "My skills · Status · Config"],
  ["n", "New skill"],
  ["← ↑ ↓ →", "Select a skill (library) · navigate (detail)"],
  ["↵ Enter", "Open selected skill (library)"],
  ["v", "Toggle Rendered / Source"],
  ["g", "Toggle grid / list (library)"],
  ["d", "Cycle grouping: none / domain / layer"],
  ["a", "Toggle active / archived skills"],
  ["e", "Rename skill"],
  ["r", "Refresh from the vault"],
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
    if (curView === "detail") return void go("skills");
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
  if (helpOpen || typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "f" || e.key === "F") {
    e.preventDefault();
    if (curView !== "skills") go("skills");
    setTimeout(() => $("#search")?.focus(), 0);
    return;
  }
  if (e.key === "1") return goSkillsTab();
  if (e.key === "2") return void go("status");
  if (e.key === "3") {
    // Parity with clicking the Config nav: land on the Rules pane,
    // not a remembered pane (go()'s own reset is guarded by
    // curView !== config, which is false while already in Config).
    configPane = "rules";
    return void go("config");
  }
  if (e.key === "a" && (curView === "skills" || curView === "archived")) {
    e.preventDefault();
    const t = archiveToggleTarget(libArchived);
    libArchived = t.libArchived;
    return void go(t.view);
  }
  if (e.key === "r") {
    e.preventDefault();
    return void loadState();
  }
  if (curView === "skills") {
    if (e.key === "n") return void go("new");
    if (e.key === "g") {
      e.preventDefault();
      libView = libView === "grid" ? "list" : "grid";
      if (libView === "grid" && sortMode === "updated") {
        sortMode = "name";
        sortDir = 1;
      }
      return void renderLibrary();
    }
    if (e.key === "d") {
      e.preventDefault();
      groupAxis =
        groupAxis === "none"
          ? "domain"
          : groupAxis === "domain"
            ? "layer"
            : "none";
      return void renderLibrary();
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
  if (e.key === "v") {
    if (!$("#seg")?.classList.contains("vhide")) {
      e.preventDefault();
      setMode(viewMode === "rendered" ? "source" : "rendered");
    }
    return;
  }
  if (e.key === "e") {
    e.preventDefault();
    return doRename(current);
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
    const files = [...document.querySelectorAll("#filelist .file")].map(
      (b) => b.dataset.file,
    );
    const i = files.indexOf(currentFile);
    if (i < 0) return;
    const to = e.key === "ArrowUp" ? files[i - 1] : files[i + 1];
    if (to) {
      e.preventDefault();
      selectFile(to);
    }
  }
});
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
$("#refresh").addEventListener("click", () => loadState());
$("#help-btn")?.addEventListener("click", openHelp);

let lastStateAt = 0;
async function loadState() {
  const r = await api("/api/state");
  if (!r.ok) return toast(r.data.error || "failed to load state");
  lastStateAt = Date.now();
  state = r.data;
  // Drop selections whose skill vanished (renamed/archived) so bulk ops never
  // target a ghost.
  const live = new Set([
    ...(state.skills || []).map((s) => s.name),
    ...(state.archived || []).map((s) => s.name),
  ]);
  for (const n of [...libSel]) if (!live.has(n)) libSel.delete(n);
  $("#vault").textContent =
    `${state.vaultDir.replace(/^.*\//, "~/")} · ${state.skills.length} skills`;
  sync = (await api("/api/sync")).data;
  if (state.skills.length === 0) {
    curView = "empty";
    render();
    return;
  }
  render();
  refreshSyncLive();
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
loadState();
