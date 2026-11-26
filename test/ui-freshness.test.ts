import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadUiFns } from "./ui-harness.js";

const data = {
  hasGraph: true,
  freshThroughCommit: "abc",
  updatedAt: "2026-07-26T19:00:00+02:00",
  commitsBehind: 3,
  pending: [],
  run: {
    state: "extracting",
    total: 5,
    completed: 2,
    workers: 3,
    families: ["alpha", "beta", "gamma", "delta", "epsilon"],
    lastCompleted: "beta",
    lastProvider: "codex",
    startedAt: "2026-07-26T19:00:00+02:00",
    finishedAt: null,
  },
};

test("freshSummary prioritizes active refresh over commit lag", () => {
  const ctx = loadUiFns(["liveCross", "freshSummary"]);
  const summary = (
    ctx.freshSummary as (value: unknown) => { cls: string; label: string }
  )(data);
  assert.equal(summary.cls, "warn");
  assert.equal(summary.label, "Refreshing 2/5");
});

test("freshPopHtml explains active workers and latest family", () => {
  const ctx = loadUiFns(
    [
      "esc",
      "liveCross",
      "famRowHtml",
      "runBarHtml",
      "runFamilyRowsHtml",
      "staleRowsHtml",
      "freshPopHtml",
    ],
    {
      agoLabel: () => "now",
      freshDoneOpen: false,
      FRESH_CHECK_SVG: "check",
      FRESH_COPY_SVG: "copy",
    },
  );
  const html = String((ctx.freshPopHtml as (value: unknown) => string)(data));
  assert.match(html, /Refreshing 2 of 5 families/);
  assert.match(html, /3 workers/);
  assert.match(html, /beta/);
  assert.match(html, /codex/);
});

test("freshPollDelay polls only while a refresh is active", () => {
  const ctx = loadUiFns(["freshPollDelay"]);
  const delay = ctx.freshPollDelay as (value: unknown) => number | null;
  assert.equal(delay(data), 5000);
  assert.equal(delay({ ...data, run: { ...data.run, state: "idle" } }), null);
  assert.equal(delay(null), null);
});

const runWithFamilies = {
  hasGraph: true,
  freshThroughCommit: "abc",
  updatedAt: "2026-07-26T19:00:00+02:00",
  commitsBehind: 4,
  pending: [],
  stale: [
    {
      family: "linkedin",
      skills: ["linkedin-analytics", "linkedin-founder-content"],
      commits: 2,
      command: "graphify-refresh.py linkedin",
    },
  ],
  run: {
    state: "extracting",
    total: 4,
    completed: 2,
    workers: 3,
    families: ["bottega19", "skill", "wedding", "personal"],
    familyState: [
      {
        family: "wedding",
        state: "running",
        skills: 2,
        seconds: 71,
        provider: "codex",
        reason: "",
      },
      {
        family: "personal",
        state: "failed",
        skills: 2,
        seconds: null,
        provider: null,
        reason: "degenerate chunk",
      },
      {
        family: "bottega19",
        state: "done",
        skills: 9,
        seconds: 212.4,
        provider: "codex",
        reason: "",
      },
      {
        family: "skill",
        state: "queued",
        skills: 5,
        seconds: null,
        provider: null,
        reason: "",
      },
    ],
    lastCompleted: "bottega19",
    lastProvider: "codex",
    startedAt: "2026-07-26T19:00:00+02:00",
    finishedAt: null,
  },
};

test("the popover shows one row per family instead of a bare counter", () => {
  const ctx = loadUiFns(
    [
      "esc",
      "liveCross",
      "famRowHtml",
      "runBarHtml",
      "runFamilyRowsHtml",
      "staleRowsHtml",
      "freshPopHtml",
    ],
    {
      agoLabel: () => "now",
      freshDoneOpen: false,
      FRESH_CHECK_SVG: "check",
      FRESH_COPY_SVG: "copy",
    },
  );
  const html = String(
    (ctx.freshPopHtml as (value: unknown) => string)(runWithFamilies),
  );
  assert.match(html, /fp-row running[\s\S]*wedding[\s\S]*running · 71s/);
  assert.match(html, /fp-row failed[\s\S]*personal/);
  assert.match(html, /degenerate chunk/);
  assert.match(html, /graphify-refresh\.py personal/);
  assert.match(html, /fp-row done[\s\S]*bottega19[\s\S]*done · 212s/);
  assert.match(html, /fp-row queued[\s\S]*skill[\s\S]*queued/);
  // The one-line run summary is replaced, not doubled up.
  assert.doesNotMatch(
    html,
    /Refreshing 2 of 4 families<\/div><div class="fp-behind">3 workers/,
  );
});

test("stale families are listed with what changed and how far behind", () => {
  const ctx = loadUiFns(
    [
      "esc",
      "liveCross",
      "famRowHtml",
      "runBarHtml",
      "runFamilyRowsHtml",
      "staleRowsHtml",
      "freshPopHtml",
    ],
    {
      agoLabel: () => "now",
      freshDoneOpen: false,
      FRESH_CHECK_SVG: "check",
      FRESH_COPY_SVG: "copy",
    },
  );
  const html = String(
    (ctx.freshPopHtml as (value: unknown) => string)(runWithFamilies),
  );
  assert.match(html, /Stale, not picked up yet/);
  assert.match(html, /linkedin-analytics, linkedin-founder-content/);
  assert.match(html, /2 commits behind/);
});

test("the pill counts stale families ahead of raw commit lag", () => {
  const ctx = loadUiFns(["liveCross", "freshSummary"]);
  const summary = (
    ctx.freshSummary as (value: unknown) => { cls: string; behind: string }
  )(runWithFamilies);
  assert.equal(summary.behind, " · 1 stale");
});

test("a status file with no family state keeps the old counter line", () => {
  const ctx = loadUiFns(
    [
      "esc",
      "liveCross",
      "famRowHtml",
      "runBarHtml",
      "runFamilyRowsHtml",
      "staleRowsHtml",
      "freshPopHtml",
    ],
    {
      agoLabel: () => "now",
      freshDoneOpen: false,
      FRESH_CHECK_SVG: "check",
      FRESH_COPY_SVG: "copy",
    },
  );
  const html = String((ctx.freshPopHtml as (value: unknown) => string)(data));
  assert.match(html, /3 workers/);
  assert.doesNotMatch(html, /fp-row/);
});

test("the pill says a refresh is coming instead of looking idle", () => {
  const ctx = loadUiFns(["liveCross", "freshSummary"]);
  const summary = (
    ctx.freshSummary as (v: unknown) => { cls: string; label: string }
  )({
    ...data,
    run: { ...data.run, state: "idle" },
    armedAt: Math.floor(Date.now() / 1000) + 110,
  });
  assert.equal(summary.cls, "warn");
  assert.equal(summary.label, "Refresh in 2m");
});

test("the status line agrees with the pill when a refresh is armed", () => {
  const ctx = loadUiFns(
    [
      "esc",
      "liveCross",
      "famRowHtml",
      "runBarHtml",
      "runFamilyRowsHtml",
      "staleRowsHtml",
      "freshPopHtml",
    ],
    {
      agoLabel: () => "now",
      freshDoneOpen: false,
      FRESH_CHECK_SVG: "check",
      FRESH_COPY_SVG: "copy",
    },
  );
  const html = String(
    (ctx.freshPopHtml as (v: unknown) => string)({
      ...data,
      commitsBehind: 0,
      run: { ...data.run, state: "idle" },
      armedAt: Math.floor(Date.now() / 1000) + 30,
    }),
  );
  // "Fresh" accanto a una pill che dice "Refresh due" e' una contraddizione.
  assert.match(html, /Refresh armed/);
  assert.doesNotMatch(html, /fp-status ok/);
});

const POP_FNS = [
  "esc",
  "liveCross",
  "famRowHtml",
  "runBarHtml",
  "runFamilyRowsHtml",
  "staleRowsHtml",
  "freshPopHtml",
];
const POP_GLOBALS = {
  agoLabel: () => "now",
  freshDoneOpen: false,
  FRESH_CHECK_SVG: "check",
  FRESH_COPY_SVG: "copy",
};

test("the progress bar counts what the headline counts, in two tones", () => {
  const ctx = loadUiFns(POP_FNS, POP_GLOBALS);
  const html = String(
    (ctx.freshPopHtml as (v: unknown) => string)(runWithFamilies),
  );
  // 2 of 4 extraction-complete, of which 1 already applied: a bar driven by
  // `done` alone would read 25% under a line saying 2 of 4.
  assert.match(html, /Refreshing 2 of 4 families/);
  assert.match(
    html,
    /<div class="fp-bar"><i style="transform:scaleX\(0\.5\)"><\/i><i class="done" style="transform:scaleX\(0\.25\)"><\/i><\/div>/,
  );
});

test("a run whose families all finished extraction fills the bar", () => {
  const ctx = loadUiFns(POP_FNS, POP_GLOBALS);
  const html = String(
    (ctx.freshPopHtml as (v: unknown) => string)({
      ...runWithFamilies,
      run: {
        ...runWithFamilies.run,
        completed: 4,
        familyState: runWithFamilies.run.familyState.map((f) => ({
          ...f,
          state: "applying",
        })),
      },
    }),
  );
  assert.match(
    html,
    /<div class="fp-bar"><i style="transform:scaleX\(1\)"><\/i><\/div>/,
  );
});

test("the family list sits in its own scroller, the bar and status do not", () => {
  const ctx = loadUiFns(POP_FNS, POP_GLOBALS);
  const html = String(
    (ctx.freshPopHtml as (v: unknown) => string)(runWithFamilies),
  );
  const at = html.indexOf('<div class="fp-scroll">');
  assert.ok(at > 0, "expected a scroll container");
  const head = html.slice(0, at);
  // Fixed above the scroller: the panel must not scroll away what it is about.
  assert.match(head, /fp-status/);
  assert.match(head, /fp-bar/);
  // Inside it: every family row, plus the stale block that follows them.
  assert.doesNotMatch(head, /fp-row/);
  assert.match(html.slice(at), /fp-row running[\s\S]*Stale, not picked up yet/);
});

test("no run means no bar and no empty scroller", () => {
  const ctx = loadUiFns(POP_FNS, POP_GLOBALS);
  const html = String(
    (ctx.freshPopHtml as (v: unknown) => string)({
      ...data,
      commitsBehind: 0,
      pending: [],
      stale: [],
      run: null,
    }),
  );
  assert.doesNotMatch(html, /fp-bar/);
  assert.doesNotMatch(html, /fp-scroll/);
});

test("the popover's flex column is scoped to the open state", () => {
  // An ID selector beats the UA's `[popover]:not(:popover-open) {display:none}`,
  // so a bare `#fresh-pop { display: flex }` un-popovers the panel: it paints on
  // load at 0,0, survives hidePopover(), and renders under the header because it
  // never enters the top layer. The rule has to carry :popover-open.
  const css = readFileSync(
    new URL("../../src/ui.css", import.meta.url),
    "utf8",
  );
  const at = css.indexOf("#fresh-pop {");
  assert.ok(at > 0, "expected a #fresh-pop rule");
  const base = css.slice(at, css.indexOf("}", at));
  assert.doesNotMatch(base, /display\s*:/);
  assert.match(css, /#fresh-pop:popover-open\s*\{[^}]*display:\s*flex/);
});

// ── the cross pass, as chosen from the mockup (variant A) ──────────────────
const crossRun = {
  ...runWithFamilies,
  run: {
    ...runWithFamilies.run,
    total: 4,
    completed: 4,
    familyState: runWithFamilies.run.familyState.map((f) => ({
      ...f,
      state: "done",
      seconds: f.seconds ?? 40,
    })),
    cross: { done: 2, total: 11, current: ["content-engine"] },
  },
};

test("during the cross pass the pill says Linking, not a finished Refreshing", () => {
  const ctx = loadUiFns(["liveCross", "freshSummary"]);
  const s = (
    ctx.freshSummary as (v: unknown) => { label: string; cls: string }
  )(crossRun);
  // "Refreshing 4/4" while still running is a contradiction.
  assert.equal(s.label, "Linking 2/11");
  assert.equal(s.cls, "warn");
});

test("during the cross pass the bar is full teal with the green cross sweep", () => {
  const ctx = loadUiFns(POP_FNS, POP_GLOBALS);
  const html = String((ctx.freshPopHtml as (v: unknown) => string)(crossRun));
  assert.match(
    html,
    /<div class="fp-bar"><i style="transform:scaleX\(1\)"><\/i><i class="done" style="transform:scaleX\(0\.182\)"><\/i><\/div>/,
  );
  // The skill being confirmed is a live row; the status line carries the count
  // alone rather than repeating the same name eight pixels up.
  assert.match(html, /Cross-linking 2 of 11 skills/);
  assert.doesNotMatch(html, /Cross-linking 2 of 11 skills · content-engine/);
  assert.match(html, /fp-row running[\s\S]*content-engine[\s\S]*linking/);
});

test("every skill in flight gets its own live row, not just the first", () => {
  // La passata cross gira su piu' skill insieme: una riga sola direbbe che sta
  // girando quella, e le altre quattro sarebbero invisibili.
  const ctx = loadUiFns(POP_FNS, POP_GLOBALS);
  const many = {
    ...crossRun,
    run: {
      ...crossRun.run,
      cross: {
        done: 2,
        total: 11,
        current: ["content-engine", "skill-authoring", "mail-triage"],
      },
    },
  };
  const html = String((ctx.freshPopHtml as (v: unknown) => string)(many));
  for (const name of ["content-engine", "skill-authoring", "mail-triage"])
    assert.match(
      html,
      new RegExp(`fp-row running[\\s\\S]*${name}[\\s\\S]*linking`),
    );
  assert.equal(html.match(/fp-row running/g)?.length, 3);
});

test("three or more finished families fold into one openable line", () => {
  const ctx = loadUiFns(POP_FNS, POP_GLOBALS);
  const html = String((ctx.freshPopHtml as (v: unknown) => string)(crossRun));
  assert.match(html, /data-fresh-done aria-expanded="false"/);
  assert.match(html, /4 families done/);
  // Folded, no per-family done row is rendered.
  assert.doesNotMatch(html, /fp-row done/);
});

test("the fold opens from module state and lists the rows below the toggle", () => {
  const ctx = loadUiFns(POP_FNS, { ...POP_GLOBALS, freshDoneOpen: true });
  const html = String((ctx.freshPopHtml as (v: unknown) => string)(crossRun));
  assert.match(html, /data-fresh-done aria-expanded="true"/);
  const fold = html.indexOf("data-fresh-done");
  assert.ok(html.indexOf("fp-row done") > fold, "done rows sit below the fold");
});

test("a sub-second family duration reads as cache, not 0s", () => {
  const ctx = loadUiFns(POP_FNS, { ...POP_GLOBALS, freshDoneOpen: true });
  const withCache = {
    ...crossRun,
    run: {
      ...crossRun.run,
      familyState: crossRun.run.familyState.map((f, i) => ({
        ...f,
        seconds: i === 0 ? 0 : f.seconds,
      })),
    },
  };
  const html = String((ctx.freshPopHtml as (v: unknown) => string)(withCache));
  assert.match(html, /done · cache/);
  assert.doesNotMatch(html, /done · 0s/);
});
