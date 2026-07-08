import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import {
  expandTilde,
  loadConfig,
  saveConfig,
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
  assert.deepEqual(loaded.archived, []);
});

test("saveConfig/loadConfig roundtrip with defaults for missing keys", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  const cfg: LoomConfig = {
    schema: 1,
    consumers: { claude: "~/.claude/skills" },
    ignore: [...DEFAULT_IGNORE],
    archived: [],
  };
  saveConfig(dir, cfg);
  const loaded = loadConfig(dir);
  assert.deepEqual(loaded, cfg);
});
