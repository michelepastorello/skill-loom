import { test } from "node:test";
import assert from "node:assert/strict";
import { loadUiFns, type UiCtx } from "./ui-harness.js";

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

const CHAIN = [
  "skillHay",
  "matchesSearch",
  "linkStateOf",
  "passesFilters",
  "groupKeyOf",
  "humanTax",
  "groupedSkills",
  "libSkills",
  "libraryOrder",
  "libSelectableOrder",
];

function libCtx(skills: unknown[], searchQ = ""): UiCtx {
  const ctx = loadUiFns(CHAIN);
  Object.assign(ctx, {
    state: { skills, names: {}, matrix: [], consumers: {} },
    searchQ,
    statusFilter: null,
    domainFilter: null,
    layerFilter: null,
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
  const ctx = loadUiFns(["skillHay", "matchesSearch"]);
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
