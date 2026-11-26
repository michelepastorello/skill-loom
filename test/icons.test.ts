import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// The generated catalog assigns to globalThis; run it in a fresh vm context and
// read the global back out of the sandbox.
function loadCatalog(): Record<string, string> {
  const src = readFileSync(new URL("../src/icons.js", import.meta.url), "utf8");
  const ctx: { SKILL_LOOM_ICONS?: Record<string, string> } = {};
  vm.runInNewContext(src, ctx);
  return ctx.SKILL_LOOM_ICONS ?? {};
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

test("icons.js ships the full Lucide catalog keyed by kebab-case name", () => {
  const cat = loadCatalog();
  const names = Object.keys(cat);
  assert.ok(names.length > 1000, `catalog has only ${names.length} icons`);
  // names that fell back to the generic glyph before this catalog existed
  for (const n of [
    "file-cog",
    "plane",
    "landmark",
    "fingerprint",
    "shield-check",
    "badge-euro",
  ])
    assert.ok(cat[n], `missing icon "${n}"`);
  const bad = names.find((n) => !KEBAB.test(n));
  assert.equal(bad, undefined, `non-kebab key: ${bad}`);
});

test("catalog values are inner shapes, not a nested <svg> root", () => {
  const cat = loadCatalog();
  assert.ok(!/<svg/i.test(cat.plane), "inner must not re-open an <svg> root");
  assert.match(cat.plane, /<path\b/);
});

test("catalog keys are sorted (deterministic output)", () => {
  const names = Object.keys(loadCatalog());
  assert.deepEqual(names, [...names].sort());
});

test("ui.html loads icons.js before ui.js", () => {
  const html = readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  const i = html.indexOf("/icons.js");
  const j = html.indexOf("/ui.js");
  assert.ok(i >= 0 && j >= 0, "both script tags present");
  assert.ok(i < j, "icons.js must load before ui.js");
});
