import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import {
  expandTilde,
  loadConfig,
  saveConfig,
  resolveConsumers,
  validateLint,
  DEFAULT_IGNORE,
  type LoomConfig,
} from "../src/config.js";
import { UsageError } from "../src/errors.js";

test("expandTilde expands ~ and ~/ but not others", () => {
  assert.equal(expandTilde("~"), homedir());
  assert.equal(expandTilde("~/x/y"), path.join(homedir(), "x/y"));
  assert.equal(expandTilde("/abs/path"), "/abs/path");
});

test("loadConfig throws UsageError when loom.json is missing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  assert.throws(() => loadConfig(dir), UsageError);
});

test("loadConfig throws UsageError when loom.json is malformed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  writeFileSync(path.join(dir, "loom.json"), "{invalid");
  assert.throws(() => loadConfig(dir), UsageError);
});

test("loadConfig fills in defaults when keys are absent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  writeFileSync(path.join(dir, "loom.json"), JSON.stringify({ schema: 1 }));
  const loaded = loadConfig(dir);
  assert.deepEqual(loaded.consumers, {});
  assert.deepEqual(loaded.ignore, DEFAULT_IGNORE);
  assert.deepEqual(loaded.names, {});
});

test("saveConfig writes consumers and names sorted by key", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  saveConfig(dir, {
    schema: 1,
    consumers: { codex: "~/.codex/skills", agents: "~/.agents/skills" },
    ignore: [...DEFAULT_IGNORE],
    names: { zeta: "Zeta", alfa: "Alfa" },
  });
  const raw = readFileSync(path.join(dir, "loom.json"), "utf8");
  assert.ok(raw.indexOf('"agents"') < raw.indexOf('"codex"'));
  assert.ok(raw.indexOf('"alfa"') < raw.indexOf('"zeta"'));
});

test("loadConfig reads the custom names map", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  writeFileSync(
    path.join(dir, "loom.json"),
    JSON.stringify({ schema: 1, names: { forpros: "ForPros" } }),
  );
  assert.deepEqual(loadConfig(dir).names, { forpros: "ForPros" });
});

test("resolveConsumers normalizes string (symlink) and object (in-place) values", () => {
  const cfg: LoomConfig = {
    schema: 1,
    consumers: {
      claude: "~/.claude/skills",
      openclaw: { mode: "in-place", note: "served via extraDirs" },
    },
    ignore: [...DEFAULT_IGNORE],
    names: {},
  };
  const list = resolveConsumers(cfg);
  const claude = list.find((c) => c.name === "claude");
  const openclaw = list.find((c) => c.name === "openclaw");
  assert.deepEqual(
    { mode: claude?.mode, dir: claude?.dir },
    { mode: "symlink", dir: path.join(homedir(), ".claude/skills") },
  );
  assert.deepEqual(
    { mode: openclaw?.mode, dir: openclaw?.dir, note: openclaw?.note },
    { mode: "in-place", dir: null, note: "served via extraDirs" },
  );
});

test("saveConfig/loadConfig preserves an in-place consumer object", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  const cfg: LoomConfig = {
    schema: 1,
    consumers: { openclaw: { mode: "in-place", note: "x" } },
    ignore: [...DEFAULT_IGNORE],
    names: {},
  };
  saveConfig(dir, cfg);
  assert.deepEqual(loadConfig(dir).consumers, {
    openclaw: { mode: "in-place", note: "x" },
  });
});

test("saveConfig/loadConfig roundtrip with defaults for missing keys", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  const cfg: LoomConfig = {
    schema: 1,
    consumers: { claude: "~/.claude/skills" },
    ignore: [...DEFAULT_IGNORE],
    names: {},
  };
  saveConfig(dir, cfg);
  const loaded = loadConfig(dir);
  assert.deepEqual(loaded, cfg);
});

test("validateLint accepts a well-formed lint block", () => {
  assert.equal(
    validateLint({
      strict: true,
      descriptionMinChars: 250,
      descriptionMaxChars: 400,
      bodyMaxLines: 120,
      forbidBodyPatterns: ["\\bTODO\\b"],
      requireSections: ["Policy"],
      requireTaxonomy: ["domain", "layer"],
      allowedDomains: ["a"],
      allowedLayers: ["b"],
    }),
    null,
  );
});

test("validateLint rejects an unknown taxonomy axis", () => {
  assert.match(
    validateLint({ requireTaxonomy: ["domain", "colour"] }) ?? "",
    /requireTaxonomy/,
  );
});

test("validateLint rejects min greater than max", () => {
  assert.match(
    validateLint({ descriptionMinChars: 500, descriptionMaxChars: 400 }) ?? "",
    /<=/,
  );
});

test("validateLint rejects an invalid forbidden regex", () => {
  assert.match(
    validateLint({ forbidBodyPatterns: ["[unclosed("] }) ?? "",
    /invalid regex/,
  );
});

test("validateLint rejects a non-array allowedDomains", () => {
  assert.match(validateLint({ allowedDomains: "a" }) ?? "", /allowedDomains/);
});
