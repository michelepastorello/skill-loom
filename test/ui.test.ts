import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadUiFns, type UiCtx } from "./ui-harness.js";

// --- taxonomy axes render generically, not by hardcoded name ----------------
// TAX_HUES is prettier-formatted across multiple lines with a trailing comma
// (`192,\n  205, ..., 34,\n]`), so a plain JSON.parse on the bracketed body
// throws — split on commas instead of parsing as JSON. What must hold is the
// gcd/length pinning, not the parsing mechanism.
test("TAX_HUES length is coprime with the hue stride", () => {
  const src = readFileSync("src/ui.js", "utf8");
  const body = /const TAX_HUES = \[([\s\S]*?)\]/.exec(src)![1];
  const len = body
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean).length;
  const stride = Number(/TAX_HUES\[\(i \* (\d+)\)/.exec(src)![1]);
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  // gcd != 1 collapses the palette: 12 hues with stride 3 yields only 4.
  assert.equal(gcd(stride, len), 1);
  assert.ok(len >= 16, "palette must cover the largest axis vocabulary");
});

test("ui.js names no taxonomy axis", () => {
  const src = readFileSync("src/ui.js", "utf8");
  assert.ok(!/let domainFilter/.test(src));
  assert.ok(!/let layerFilter/.test(src));
  assert.ok(!/groupAxis === "layer"/.test(src));
  assert.ok(!/s\.layer/.test(src));
  assert.ok(!/s\.domain/.test(src));
});

// --- linkStateOf (finding #10) ----------------------------------------------
// A non-active skill (suspended/deprecated/draft/idea) is excluded from the
// server-side matrix, so it reaches linkStateOf with zero rows. An in-place
// consumer still serves it from the vault (the detail pane and the Status grid
// both say so); linkStateOf must not report a blanket "not linked".

function withState(ctx: UiCtx, s: unknown): string {
  ctx.state = s;
  return (ctx.linkStateOf as (x: unknown) => string)({ name: "sk" } as never);
}

test("linkStateOf: active skill fully linked stays 'linked'", () => {
  const ctx = loadUiFns(["linkStateOf"]);
  const state = {
    matrix: [
      { skill: "sk", consumer: "claude", state: "linked" },
      { skill: "sk", consumer: "codex", state: "linked" },
    ],
    consumers: { claude: "/c", codex: "/x" },
  };
  assert.equal(withState(ctx, state), "linked");
});

test("linkStateOf: active skill linked on one, missing on another stays 'partial'", () => {
  const ctx = loadUiFns(["linkStateOf"]);
  const state = {
    matrix: [
      { skill: "sk", consumer: "claude", state: "linked" },
      { skill: "sk", consumer: "codex", state: "missing" },
    ],
    consumers: { claude: "/c", codex: "/x" },
  };
  assert.equal(withState(ctx, state), "partial");
});

test("linkStateOf: an external runtime does not hold a projected skill at 'partial'", () => {
  const ctx = loadUiFns(["linkStateOf"]);
  // The badge a human reads to learn a pair was declared, not broken. Counting
  // the overridden row would report "partial" forever for a skill that is on
  // every runtime the vault actually owns — the report the override exists
  // to end.
  const state = {
    matrix: [
      { skill: "sk", consumer: "claude", state: "linked" },
      { skill: "sk", consumer: "codex", state: "linked" },
      { skill: "sk", consumer: "agents", state: "external" },
    ],
    consumers: { claude: "/c", codex: "/x", agents: "/a" },
  };
  assert.equal(withState(ctx, state), "linked");
  // A real gap alongside an override is still a real gap.
  const gap = {
    ...state,
    matrix: [
      { skill: "sk", consumer: "claude", state: "linked" },
      { skill: "sk", consumer: "codex", state: "missing" },
      { skill: "sk", consumer: "agents", state: "external" },
    ],
  };
  assert.equal(withState(ctx, gap), "partial");
});

test("linkStateOf: non-active skill served by an in-place consumer is 'linked'", () => {
  const ctx = loadUiFns(["linkStateOf"]);
  const state = {
    matrix: [], // suspended skill: excluded from the matrix
    consumers: { openclaw: { mode: "in-place", servedVia: { file: "x" } } },
  };
  assert.equal(withState(ctx, state), "linked");
});

test("linkStateOf: non-active skill, in-place + symlink consumer is 'partial'", () => {
  const ctx = loadUiFns(["linkStateOf"]);
  const state = {
    matrix: [],
    consumers: {
      openclaw: { mode: "in-place", servedVia: { file: "x" } },
      claude: "/c", // symlink consumer does not project suspended skills
    },
  };
  assert.equal(withState(ctx, state), "partial");
});

test("linkStateOf: non-active skill with only symlink consumers is 'not linked'", () => {
  const ctx = loadUiFns(["linkStateOf"]);
  const state = { matrix: [], consumers: { claude: "/c" } };
  assert.equal(withState(ctx, state), "not linked");
});

// --- archiveToggleTarget (finding #1) ---------------------------------------
// The 'a' shortcut used to flip libArchived and call renderLibrary() directly,
// leaving curView stale — so a later render() (via 'r'/revalidation/any action)
// re-dispatched on curView and snapped the view back. The target view must stay
// consistent with the new libArchived so routing through go() keeps them synced.

// Fields are asserted individually: the returned object is built in the vm
// realm, so deepStrictEqual would reject it on a cross-realm prototype mismatch
// despite equal values.
test("archiveToggleTarget: from active library targets the archived view", () => {
  const ctx = loadUiFns(["archiveToggleTarget"]);
  const t = (
    ctx.archiveToggleTarget as (a: boolean) => {
      libArchived: boolean;
      view: string;
    }
  )(false);
  assert.equal(t.libArchived, true);
  assert.equal(t.view, "archived");
});

test("archiveToggleTarget: from archived library targets the active skills view", () => {
  const ctx = loadUiFns(["archiveToggleTarget"]);
  const t = (
    ctx.archiveToggleTarget as (a: boolean) => {
      libArchived: boolean;
      view: string;
    }
  )(true);
  assert.equal(t.libArchived, false);
  assert.equal(t.view, "skills");
});

// --- range-select respects the live search (finding #33) --------------------
// libraryOrder() applies the rail filters but leaves search to the DOM, so a
// range built on it pulled in search-hidden skills. Both shift+click and
// shift+arrow route through libSelRange, which now iterates a search-aware
// order (libSelectableOrder). Arrays returned from the vm realm are spread into
// test-realm arrays before comparison (cross-realm prototype mismatch).

// The declared-axes stand-in every test below seeds into state.axes: the
// legacy domain/layer pair, so existing skill fixtures (which still carry
// domain/layer properties) exercise axisList()-driven code paths unchanged.
const AXES = [
  { id: "domain", label: null, values: [] },
  { id: "layer", label: null, values: [] },
];

const CHAIN = [
  "axisList",
  "humanTax",
  "skillHay",
  "matchesSearch",
  "linkStateOf",
  "passesFilters",
  "groupKeyOf",
  "groupedSkills",
  "libSkills",
  "libraryOrder",
  "libSelectableOrder",
];

function libCtx(skills: unknown[], searchQ = ""): UiCtx {
  const ctx = loadUiFns(CHAIN);
  Object.assign(ctx, {
    state: { skills, names: {}, matrix: [], consumers: {}, axes: AXES },
    searchQ,
    statusFilter: null,
    axisFilters: {},
    linkFilter: null,
    syncFilter: null,
    sortMode: "name",
    sortDir: 1,
    groupAxis: "none",
    libArchived: false,
  });
  return ctx;
}

const SK = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  title: name,
  description: "",
  domain: "",
  layer: "",
  ...extra,
});

const order = (ctx: UiCtx, fn: string) => [...(ctx[fn] as () => string[])()];

test("matchesSearch: empty query matches everything, else matches the haystack", () => {
  const ctx = loadUiFns(["axisList", "skillHay", "matchesSearch"]);
  ctx.state = { axes: AXES };
  const m = (s: unknown) => (ctx.matchesSearch as (x: unknown) => boolean)(s);
  ctx.searchQ = "";
  assert.equal(m(SK("alpha")), true);
  ctx.searchQ = "graph";
  assert.equal(m(SK("graphify")), true);
  assert.equal(m(SK("alpha", { domain: "graph-tools" })), true); // domain is in the haystack
  assert.equal(m(SK("beta")), false);
});

test("libSelectableOrder: no search query matches libraryOrder", () => {
  const ctx = libCtx([SK("alpha"), SK("beta")], "");
  assert.deepEqual(order(ctx, "libSelectableOrder"), ["alpha", "beta"]);
  assert.deepEqual(order(ctx, "libraryOrder"), ["alpha", "beta"]);
});

test("libSelectableOrder: an active search excludes non-matching skills that libraryOrder still lists", () => {
  const ctx = libCtx([SK("alpha"), SK("beta"), SK("alpine")], "alp");
  // libraryOrder is search-agnostic (the bug's source): all three.
  assert.deepEqual(order(ctx, "libraryOrder"), ["alpha", "alpine", "beta"]);
  // The selectable order drops the search-hidden "beta".
  assert.deepEqual(order(ctx, "libSelectableOrder"), ["alpha", "alpine"]);
});

test("libSelectableOrder: a search-hidden anchor is absent, so libSelRange's indexOf falls back", () => {
  const ctx = libCtx([SK("alpha"), SK("beta")], "alp");
  assert.equal(order(ctx, "libSelectableOrder").includes("beta"), false);
});

// --- "Today" uses the local calendar date (finding #38) ---------------------
// fmtWhen compared iso against now.toISOString() (UTC), so ~1-2h after local
// midnight in a zone ahead of UTC a date modified "today" failed the Today
// branch. Both sides must use the local calendar date. Asia/Kolkata (+5:30, no
// DST) makes the instant below local-day-15 but UTC-day-14 — the bug window.
function withTZ(tz: string, fn: () => void): void {
  const orig = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    if (orig === undefined) delete process.env.TZ;
    else process.env.TZ = orig;
  }
}

// 2026-07-14 19:30 UTC == 2026-07-15 01:00 IST.
const AFTER_LOCAL_MIDNIGHT = new Date("2026-07-14T19:30:00Z");

test("localDateStr: returns the local calendar date, not the UTC date", () => {
  const ctx = loadUiFns(["localDateStr"]);
  withTZ("Asia/Kolkata", () => {
    const local = (ctx.localDateStr as (d: Date) => string)(
      AFTER_LOCAL_MIDNIGHT,
    );
    assert.equal(local, "2026-07-15");
    assert.notEqual(local, AFTER_LOCAL_MIDNIGHT.toISOString().slice(0, 10)); // "2026-07-14"
  });
});

test("fmtWhen: a date equal to the local 'today' reads 'Today' just after local midnight", () => {
  const ctx = loadUiFns(["localDateStr", "fmtWhen"]);
  withTZ("Asia/Kolkata", () => {
    const fmt = ctx.fmtWhen as (iso: string, now: Date) => string;
    assert.equal(fmt("2026-07-15", AFTER_LOCAL_MIDNIGHT), "Today");
  });
});

// --- fmtLong: history shows date + time (a "T" marks a commit datetime) ------
test("fmtLong: renders date + 24h time when the value carries a time", () => {
  const ctx = loadUiFns(["fmtLong"]);
  const f = ctx.fmtLong as (iso: string) => string;
  const withTime = f("2026-07-15T16:26");
  assert.match(withTime, /16:26/); // 24h time is shown
  assert.match(withTime, /(July|Jul)\s*15/); // date still shown
  assert.doesNotMatch(f("2026-07-15"), /\d:\d/); // a bare date stays timeless
});

// --- parseFrontmatter: flow-style arrays [ ... ], inline and multi-line ------
test("parseFrontmatter: reads flow arrays inline and across lines", () => {
  const ctx = loadUiFns(["parseFrontmatter"]);
  const parse = ctx.parseFrontmatter as (
    fm: string,
  ) => Array<[string, unknown]>;
  const multi = parse(
    [
      "name: s",
      "metadata:",
      "  sources:",
      "    [",
      "      a.one,",
      "      a.two,",
      "    ]",
    ].join("\n"),
  );
  const meta = multi.find(([k]) => k === "metadata")?.[1] as {
    obj: Array<[string, { list: string[] }]>;
  };
  const sources = meta.obj.find(([k]) => k === "sources")?.[1];
  // spread: parseFrontmatter runs in a vm realm, so its Array fails a
  // cross-realm deepStrictEqual prototype check; the string items are fine.
  assert.deepEqual([...(sources?.list ?? [])], ["a.one", "a.two"]);

  const inline = parse("tools: [read, write]") as Array<
    [string, { list: string[] }]
  >;
  assert.deepEqual([...(inline[0][1].list ?? [])], ["read", "write"]);
});

// --- srcSections -------------------------------------------------------------
// Read-only sources group at two levels: the runtime (the chip) and what the
// skills were installed as (the section). The pool's groups are the repo a skill
// happened to ship in, so one-skill repos are noise and collapse into a bucket;
// a plugin is the unit you install and remove, so a plugin of one keeps its name.

// srcSections runs inside the vm, so its arrays carry that realm's prototypes
// and deepEqual would reject them as not reference-equal. Round-trip through
// JSON to bring the value back into this realm as plain data.
const sections = (
  ctx: UiCtx,
  src: unknown,
  skills: unknown,
): { key: string; label: string; skills: { name: string }[] }[] =>
  JSON.parse(
    JSON.stringify(
      (ctx.srcSections as (a: unknown, b: unknown) => unknown)(src, skills),
    ),
  );

const poolSrc = {
  axis: "Source",
  groups: [
    { key: "acme/kit", label: "kit", count: 2 },
    { key: "solo-dev/one", label: "one", count: 1 },
    { key: "other-dev/two", label: "two", count: 1 },
  ],
};
const poolSkills = [
  { name: "a", group: "acme/kit" },
  { name: "b", group: "acme/kit" },
  { name: "c", group: "solo-dev/one" },
  { name: "d", group: "other-dev/two" },
];

test("srcSections: the pool's one-skill groups collapse into the unbundled bucket", () => {
  const ctx = loadUiFns(["srcSections"]);
  const out = sections(ctx, poolSrc, poolSkills);
  assert.deepEqual(
    out.map((s) => [s.label, s.skills.map((x) => x.name)]),
    [
      ["Unbundled", ["c", "d"]],
      ["kit", ["a", "b"]],
    ],
  );
});

test("srcSections: what nothing bundled leads, so the named collections read as a list", () => {
  const ctx = loadUiFns(["srcSections"]);
  const src = {
    axis: "Plugin",
    groups: [
      { key: "ops", label: "ops", count: 1 },
      { key: "(unbundled)", label: "Unbundled", count: 2 },
      { key: "powers", label: "powers", count: 1 },
    ],
  };
  const out = sections(ctx, src, [
    { name: "runbook", group: "ops" },
    { name: "graphify", group: "(unbundled)" },
    { name: "svg", group: "(unbundled)" },
    { name: "hook", group: "powers" },
  ]);
  assert.deepEqual(
    out.map((s) => s.label),
    ["Unbundled", "ops", "powers"],
  );
});

test("srcSections: a runtime's loose dirs join the same bucket as the pool's one-offs", () => {
  const ctx = loadUiFns(["srcSections"]);
  // The server already keys both as (unbundled); the bucket must not make a
  // second one beside it.
  const src = {
    axis: "Source",
    groups: [
      { key: "(unbundled)", label: "Unbundled", count: 1 },
      { key: "solo/one", label: "one", count: 1 },
    ],
  };
  const out = sections(ctx, src, [
    { name: "hand-dropped", group: "(unbundled)" },
    { name: "c", group: "solo/one" },
  ]);
  // Alphabetical among themselves: with no heading and no collection behind
  // them, the group order they arrived in means nothing to the reader.
  assert.deepEqual(
    out.map((s) => [s.key, s.skills.map((x) => x.name)]),
    [["(unbundled)", ["c", "hand-dropped"]]],
  );
});

test("srcSections: the bucket leads even when its members come last", () => {
  const ctx = loadUiFns(["srcSections"]);
  const src = {
    axis: "Source",
    groups: [
      { key: "acme/kit", label: "kit", count: 2 },
      { key: "solo/one", label: "one", count: 1 },
    ],
  };
  const out = sections(ctx, src, [
    { name: "a", group: "acme/kit" },
    { name: "b", group: "acme/kit" },
    { name: "c", group: "solo/one" },
  ]);
  assert.deepEqual(
    out.map((s) => s.label),
    ["Unbundled", "kit"],
  );
});

test("srcSections: a plugin that ships one skill keeps its own name, uncollapsed", () => {
  const ctx = loadUiFns(["srcSections"]);
  const src = {
    axis: "Plugin",
    groups: [
      { key: "ops", label: "ops", count: 2 },
      { key: "hookify", label: "hookify", count: 1 },
    ],
  };
  const out = sections(ctx, src, [
    { name: "runbook", group: "ops" },
    { name: "vendor", group: "ops" },
    { name: "hook", group: "hookify" },
  ]);
  assert.deepEqual(
    out.map((s) => s.label),
    ["ops", "hookify"],
  );
});

test("srcSections: searching down to one skill does not collapse its group", () => {
  const ctx = loadUiFns(["srcSections"]);
  // Only one of acme/kit's two skills survives the filter. The group is still a
  // real two-skill collection, so it must keep its name, not become a bucket.
  const out = sections(ctx, poolSrc, [{ name: "a", group: "acme/kit" }]);
  assert.deepEqual(
    out.map((s) => [s.label, s.skills.map((x) => x.name)]),
    [["kit", ["a"]]],
  );
});

test("srcSections: a source with nothing but loose dirs is all one bucket", () => {
  const ctx = loadUiFns(["srcSections"]);
  const out = sections(
    ctx,
    {
      axis: "",
      groups: [{ key: "(unbundled)", label: "Unbundled", count: 2 }],
    },
    [
      { name: "a", group: "(unbundled)" },
      { name: "b", group: "(unbundled)" },
    ],
  );
  assert.deepEqual(
    out.map((s) => [s.key, s.skills.map((x) => x.name)]),
    [["(unbundled)", ["a", "b"]]],
  );
});

// --- srcVisibleSections -------------------------------------------------------
// The rail facets filter the list. The subtle case is the collapsed bucket: its
// rows carry their own real group, not the bucket's key, so filtering has to run
// on sections rather than on each skill's group.

const visible = (
  ctx: UiCtx,
  src: unknown,
  skills: unknown,
  filter: string,
): { key: string; label: string; skills: { name: string }[] }[] =>
  JSON.parse(
    JSON.stringify(
      (
        ctx.srcVisibleSections as (a: unknown, b: unknown, c: string) => unknown
      )(src, skills, filter),
    ),
  );

test("srcVisibleSections: no filter shows every section", () => {
  const ctx = loadUiFns(["srcSections", "srcVisibleSections"]);
  const out = visible(ctx, poolSrc, poolSkills, "");
  assert.deepEqual(
    out.map((s) => s.label),
    ["Unbundled", "kit"],
  );
});

test("srcVisibleSections: a filter keeps only its section", () => {
  const ctx = loadUiFns(["srcSections", "srcVisibleSections"]);
  const out = visible(ctx, poolSrc, poolSkills, "acme/kit");
  assert.deepEqual(
    out.map((s) => [s.label, s.skills.map((x) => x.name)]),
    [["kit", ["a", "b"]]],
  );
});

test("srcVisibleSections: filtering on the bucket keeps the skills it swallowed", () => {
  const ctx = loadUiFns(["srcSections", "srcVisibleSections"]);
  // c and d each belong to a one-skill repo, so their rows say "solo-dev/one"
  // and "other-dev/two" — never "(independent)". Filtering must still find them.
  const out = visible(ctx, poolSrc, poolSkills, "(unbundled)");
  assert.deepEqual(
    out.map((s) => [s.label, s.skills.map((x) => x.name)]),
    [["Unbundled", ["c", "d"]]],
  );
});

// ── a11y regressions the audit of 2026-07-28 found and fixed ──────────────
const UI_CSS = readFileSync(
  new URL("../../src/ui.css", import.meta.url),
  "utf8",
);
const UI_JS = readFileSync(new URL("../../src/ui.js", import.meta.url), "utf8");
const UI_HTML = readFileSync(
  new URL("../../src/ui.html", import.meta.url),
  "utf8",
);

test("every focusable control keeps a focus ring (WCAG 2.4.7)", () => {
  // The regression this pins: `:focus-visible { outline: none }` with no
  // replacement, which left keyboard users with no indicator anywhere on a
  // surface that writes to git.
  const rule = UI_CSS.slice(
    UI_CSS.indexOf(":focus-visible {"),
    UI_CSS.indexOf("}", UI_CSS.indexOf(":focus-visible {")),
  );
  assert.match(rule, /outline:\s*2px solid var\(--accent\)/);
  assert.doesNotMatch(rule, /outline:\s*none/);
});

test("the taxonomy tint carries a separate ink value for text", () => {
  // One lightness cannot clear 4.5:1 as text on its own 16% fill in both
  // themes: 59% measured 2.87-3.62. The fill keeps 59%, the text mirrors.
  assert.match(UI_JS, /--tint-ink:light-dark\(oklch\(41%/);
  assert.match(UI_CSS, /color: var\(--tint-ink, var\(--tint, var\(--dim\)\)\)/);
});

test("the toast is a live region", () => {
  assert.match(UI_HTML, /id="toast"[^>]*role="status"/);
  assert.match(UI_HTML, /id="toast"[^>]*aria-live="polite"/);
});

test("every dialog is named by its own heading", () => {
  for (const id of ["confirm", "prompt"])
    assert.match(
      UI_HTML,
      new RegExp(`<dialog id="${id}" aria-labelledby="${id}-title"`),
      `dialog #${id} is unnamed`,
    );
});

test("the Rules editor names every control it renders", () => {
  // These are the fields that rewrite loom.json; a screen reader read them as
  // anonymous boxes before the audit.
  for (const frag of [
    'class="chip add" type="text" placeholder="+ add" aria-label="Add to ',
    'class="num" type="text" inputmode="numeric" aria-label="',
    'class="rxinput" type="text" aria-label="Forbidden pattern ',
  ])
    assert.ok(UI_JS.includes(frag), `unlabeled control: ${frag}`);
  assert.match(UI_JS, /id="search"[^>]*aria-label="Search your skills"/);
});

test("the detail collapses its rails into callable panes below 1100px", () => {
  // At 860px the three-pane layout left the document 300px — a 35-character
  // line. Both rails become overlays, and the buttons that call them only
  // exist below the breakpoint.
  assert.match(
    UI_CSS,
    /@media \(max-width: 1100px\)[\s\S]*?\.panebtn\.meta \{\s*display: inline-block/,
  );
  assert.match(
    UI_CSS,
    /@media \(max-width: 820px\)[\s\S]*?\.panebtn\.files \{\s*display: inline-block/,
  );
  assert.match(UI_CSS, /\.panebtn \{\s*display: none/);
  assert.match(UI_JS, /aria-expanded="false" aria-controls="filelist"/);
  assert.match(UI_JS, /aria-expanded="false" aria-controls="metapane"/);
});

test("Escape closes an open detail pane without leaving the view", () => {
  // Escape is bound globally to "go back". With a pane open it must mean
  // "close the pane" and stop — one keystroke doing both would dismiss the
  // overlay AND throw the reader back to the library.
  const handler = UI_JS.slice(UI_JS.indexOf("let detailPaneEsc = null;"));
  assert.match(handler, /e\.stopPropagation\(\)/);
  assert.match(handler, /e\.preventDefault\(\)/);
  // Capture phase, or the global handler runs first and the point is lost.
  assert.match(handler, /\},\s*true,\s*\);/);
  // Registered once for the page: inside wireDetailPanes it would stack a new
  // listener per skill opened.
  const wire = UI_JS.slice(
    UI_JS.indexOf("function wireDetailPanes"),
    UI_JS.indexOf("let detailPaneEsc = null;"),
  );
  assert.doesNotMatch(wire, /document\.addEventListener/);
});

test("both detail views can call their file rail back below the breakpoint", () => {
  // The read-only source detail shares the .layout rail rule, so it needs the
  // button and the wiring too: without them its file list slides off-canvas at
  // 820px with nothing able to return it.
  assert.match(UI_JS, /aria-controls="srcfilelist"/);
  const srcRender = UI_JS.slice(
    UI_JS.indexOf('class="layout srclayout"'),
    UI_JS.indexOf("function srcSelectFile"),
  );
  assert.match(srcRender, /wireDetailPanes\(\)/);
});

test("the pill's sub-label takes the pill's colour, never a neutral grey", () => {
  // "· 1 behind" was --faint (a blue-hued grey) on the amber warn fill:
  // 3.74:1 in dark, 3.30 in light, and washed out on top of that. It inherits
  // the state colour now and stays secondary through weight alone.
  const rule = UI_CSS.slice(
    UI_CSS.indexOf(".fresh-pill .k {"),
    UI_CSS.indexOf("}", UI_CSS.indexOf(".fresh-pill .k {")),
  );
  assert.doesNotMatch(rule, /color:/);
  assert.match(rule, /font-weight: 500/);
});

test("each state colour has an ink variant for text on its own soft fill", () => {
  // accent, warn and err all lose the 4.5 margin when used as text on their
  // own 12-17% fill. One token each, same hue, one step further out.
  for (const tok of ["--accent-ink", "--warn-ink", "--err-ink"])
    assert.match(
      UI_CSS,
      new RegExp(`${tok}: light-dark\\(oklch\\(`),
      `${tok} is missing`,
    );
});

test("the doc viewer never forces emoji presentation on the whole document", () => {
  // font-variant-emoji: emoji on .doc turned every digit into its fullwidth
  // keycap-base glyph — "Bottega19" rendered as "Bottega １ ９" everywhere.
  // Digits, # and * are emoji-capable codepoints; the property is a per-glyph
  // tool at best, never a container-wide default. Star rendering is owned by
  // the Lucide swap in emojiIcons, not by this.
  assert.doesNotMatch(UI_CSS, /font-variant-emoji/);
});

test("a pinned hue beats the rank palette, and carries its chroma", () => {
  const ctx = loadUiFns(
    ["axisList", "tintVars", "pinnedHue", "hueHash", "taxHueStyle"],
    {
      TAX_HUES: [192, 205],
      state: {
        skills: [{ area: "commercial" }, { area: "content" }],
        axes: [
          { id: "area", hues: { commercial: [52], technology: [240, 0.05] } },
        ],
      },
    },
  );
  const style = ctx.taxHueStyle as (a: string, v: string) => string;
  assert.match(style("area", "commercial"), /oklch\(59% 0\.135 52\)/);
  // Quiet values keep their declared chroma in fill AND ink.
  assert.match(style("area", "technology"), /oklch\(59% 0\.05 240\)/);
  assert.match(style("area", "technology"), /oklch\(41% 0\.048 240\)/);
  // Unpinned values still get the rank palette — pinning is per-value.
  assert.match(style("area", "content"), /0\.135 (192|205)\)/);
});

test("a tile with no icon-color inherits the tile axis's pinned hue", () => {
  const ctx = loadUiFns(
    [
      "esc",
      "axisList",
      "namedColor",
      "chosenColor",
      "tintVars",
      "pinnedHue",
      "iconInner",
      "skillTile",
    ],
    {
      NC_HUE: { red: 25 },
      NC_L: { 600: 50 },
      NC_C: { 600: 1 },
      NC_NEUTRAL: new Set(),
      ICONS: {},
      state: {
        skills: [],
        axes: [{ id: "area", tile: true, hues: { commercial: [52] } }],
      },
    },
  );
  const tile = ctx.skillTile as (s: unknown) => string;
  // No icon-color -> the area's pinned hue, identical to the chip.
  assert.match(
    tile({ name: "x", area: "commercial" }),
    /oklch\(59% 0\.135 52\)/,
  );
  // icon-color still wins: the product override.
  const withColor = String(
    tile({ name: "y", area: "commercial", iconColor: "red-600" }),
  );
  assert.doesNotMatch(withColor, /0\.135 52\)/);
});

test("a neutral product override does not inherit the area hue", () => {
  const ctx = loadUiFns(
    [
      "esc",
      "axisList",
      "namedColor",
      "chosenColor",
      "tintVars",
      "pinnedHue",
      "iconInner",
      "skillTile",
      "railIcon",
    ],
    {
      NC_HUE: { neutral: 250 },
      NC_NEUTRAL: new Set(["neutral"]),
      ICONS: {},
      state: {
        skills: [],
        axes: [{ id: "area", tile: true, hues: { commercial: [52] } }],
      },
    },
  );
  const skill = {
    name: "attio",
    area: "commercial",
    icon: "contact-round",
    iconColor: "neutral-500",
  };
  const tile = String((ctx.skillTile as (s: unknown) => string)(skill));
  const rail = String((ctx.railIcon as (s: unknown) => string)(skill));
  assert.match(tile, /oklch\(59% 0 250\)/);
  assert.match(rail, /oklch\(59% 0 250\)/);
  assert.doesNotMatch(tile, /0\.135 52\)/);
  assert.doesNotMatch(rail, /0\.135 52\)/);
});

test("a product override renders at the same weight as an inherited tile", () => {
  // orange-600 used to emit oklch(54% 0.15 52) with no ink var while the
  // inherited tile emitted oklch(59% 0.135 52) with one: same hue family, two
  // weights, visibly mismatched in the same column. The token now carries only
  // its hue — lightness, chroma, soft and ink all come from tintVars.
  const ctx = loadUiFns(
    [
      "esc",
      "axisList",
      "namedColor",
      "chosenColor",
      "tintVars",
      "pinnedHue",
      "iconInner",
      "skillTile",
    ],
    {
      NC_HUE: { orange: 52 },
      NC_NEUTRAL: new Set(["neutral"]),
      ICONS: {},
      state: {
        skills: [],
        axes: [{ id: "area", tile: true, hues: { commercial: [52] } }],
      },
    },
  );
  const tile = ctx.skillTile as (s: unknown) => string;
  const override = tile({ name: "pptx", iconColor: "orange-600" });
  const inherited = tile({ name: "outreach", area: "commercial" });
  const style = (h: string) => /style="([^"]+)"/.exec(h)?.[1];
  assert.equal(style(override), style(inherited));
});

// --- gallery ----------------------------------------------------------------
// The grid is drawn from the file listing the rail already has, so these are
// pure functions over that listing: what earns a Gallery row, and how the
// images are grouped once it is opened.
const GAL_SEED = {
  GALLERY_MIN: 2,
  GALLERY_KEY: " gallery",
  GALLERY_IC: "<svg></svg>",
  currentFile: null,
};
function galCtx(names: string[], seed: Record<string, unknown> = {}): UiCtx {
  return loadUiFns(["esc", "fmtSize", "imagesOf", ...names], {
    ...GAL_SEED,
    ...seed,
  });
}
const IMG = (path: string) => ({ path, size: 1024, kind: "image" });
const TXT = (path: string) => ({ path, size: 100, kind: "text" });

test("the gallery entry appears only above the image threshold", () => {
  const ctx = galCtx(["galleryPanelHtml"]);
  const panel = ctx.galleryPanelHtml as (f: unknown[]) => string;
  // One image is the file itself, one click further away.
  assert.equal(panel([TXT("SKILL.md"), IMG("assets/a.png")]), "");
  const two = panel([IMG("assets/a.png"), IMG("assets/b.png")]);
  assert.match(two, /class="fname">Gallery</);
  // The Files heading below is the separation; a heading of its own over one
  // row, and a rule under it, said the same thing three times.
  assert.ok(!two.includes("railh"));
  assert.ok(!two.includes("railsplit"));
  // The count is the images, not the files.
  assert.match(
    panel([TXT("SKILL.md"), IMG("a.png"), IMG("b.png"), IMG("c.png")]),
    /class="sz">3</,
  );
});

test("the gallery entry is the selected rail row while the grid is open", () => {
  const off = galCtx(["galleryPanelHtml"]);
  const on = galCtx(["galleryPanelHtml"], { currentFile: " gallery" });
  const files = [IMG("a.png"), IMG("b.png")];
  const panel = (c: UiCtx) =>
    (c.galleryPanelHtml as (f: unknown[]) => string)(files);
  assert.ok(!/class="file sel"/.test(panel(off)));
  assert.ok(/class="file sel"/.test(panel(on)));
});

test("the lightbox walks the grid's reading order, not the raw listing", () => {
  const ctx = galCtx(["galleryGroups", "galleryOrder"]);
  const order = ctx.galleryOrder as (f: unknown[]) => string[];
  // The server sorts by path, which puts a folder's contents before a sibling
  // file sharing its prefix ("…/black-and-white/x" < "…/business.png"). The
  // grid shows root images first, so the arrows must follow the grid.
  // Spread out of the vm realm: a cross-realm array fails reference equality.
  assert.deepEqual(
    [
      ...order([
        IMG("assets/black-and-white/x.png"),
        IMG("assets/business.png"),
        IMG("assets/casual.png"),
      ]),
    ],
    [
      "assets/business.png",
      "assets/casual.png",
      "assets/black-and-white/x.png",
    ],
  );
});

test("the gallery groups by folder and labels only when there is a choice", () => {
  const ctx = galCtx(["galleryGroups", "galleryHtml"]);
  const html = ctx.galleryHtml as (
    f: unknown[],
    u: (p: string) => string,
  ) => string;
  const raw = (p: string) => `/api/file-raw?path=${p}`;
  // One folder: the skill's own name above the grid already says whose images
  // these are, so a single heading would label nothing.
  const one = html([IMG("assets/a.png"), IMG("assets/b.png")], raw);
  assert.equal((one.match(/class="galsec"/g) || []).length, 1);
  assert.ok(!one.includes("galhead"));
  // Two folders: finals beside an archive are two sets, and each says so.
  const two = html(
    [IMG("a.png"), IMG("assets/b.png"), IMG("assets/c.png")],
    raw,
  );
  assert.equal((two.match(/class="galsec"/g) || []).length, 2);
  assert.match(two, /class="galdir">root</);
  assert.match(two, /class="galn">2 images</);
  // Root leads, exactly as it does in the rail's file list.
  assert.ok(two.indexOf(">root<") < two.indexOf(">assets<"));
});

test("the gallery draws images only, and escapes the paths it carries", () => {
  const ctx = galCtx(["galleryGroups", "galleryHtml"]);
  const draw = ctx.galleryHtml as (
    f: unknown[],
    u: (p: string) => string,
  ) => string;
  const html = draw(
    [TXT("SKILL.md"), IMG('a"b.png'), IMG("c.png")],
    (p: string) => `/api/file-raw?path=${p}`,
  );
  assert.ok(!html.includes("SKILL.md"));
  assert.equal((html.match(/class="galtile"/g) || []).length, 2);
  assert.ok(!html.includes('data-galfile="a"b.png"'));
  assert.match(html, /data-galfile="a&quot;b\.png"/);
});

test("a vector fits the tile, a photograph fills it", () => {
  const ctx = galCtx(["galleryGroups", "galleryHtml"]);
  const draw = ctx.galleryHtml as (
    f: unknown[],
    u: (p: string) => string,
  ) => string;
  const html = draw([IMG("logo.SVG"), IMG("portrait.png")], (p) => p);
  // Case is the filesystem's business, not the reader's.
  assert.equal((html.match(/class="galimg vec"/g) || []).length, 1);
  assert.equal((html.match(/class="galimg"/g) || []).length, 1);
});

test("a folder heading elides only a parent already written out above it", () => {
  const ctx = loadUiFns(["compactDirLabel"]);
  const label = ctx.compactDirLabel as (d: string, shown: string[]) => string;
  // First heading of a run says the whole path.
  assert.equal(label("assets/profile-photos", []), "assets / profile-photos");
  // A descendant of a heading above keeps its own segment only.
  assert.equal(
    label("assets/profile-photos/ai-generated", ["assets/profile-photos"]),
    "/ ai-generated",
  );
  // Still elides against an ancestor two headings back, not just the previous
  // one: every child of profile-photos reads the same way.
  assert.equal(
    label("assets/profile-photos/black-and-white", [
      "assets/profile-photos",
      "assets/profile-photos/ai-generated",
    ]),
    "/ black-and-white",
  );
  // A SIBLING is not a parent. "assets" is shared with assets/avatar-rings but
  // no heading ever said "assets" alone, so eliding it would mark a sibling as
  // a descendant of the heading above.
  assert.equal(
    label("assets/profile-photos", ["assets/avatar-rings"]),
    "assets / profile-photos",
  );
  // Prefixes are matched on path boundaries, not characters.
  assert.equal(
    label("assets/profile-photos", ["assets/profile"]),
    "assets / profile-photos",
  );
  // Nothing above: no leading slash standing in for a parent never shown.
  assert.equal(label("config", ["assets/profile-photos"]), "config");
});
