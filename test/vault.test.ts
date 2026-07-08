import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFileSync } from "node:fs";
import {
  scanVault,
  validateVault,
  parseFrontmatterName,
  parseFrontmatterField,
  NAME_RE,
} from "../src/vault.js";
import { makeTmp, makeSkill, makeConfig } from "./helpers.js";

test("parseFrontmatterField reads inline, folded (>) and literal (|) scalars", () => {
  const vault = makeTmp();
  const md = path.join(makeSkill(vault, "c", "s"), "SKILL.md");
  writeFileSync(md, "---\nname: s\ndescription: inline value\n---\n\n# s\n");
  assert.equal(parseFrontmatterField(md, "description"), "inline value");

  writeFileSync(
    md,
    "---\nname: s\ndescription: >-\n  first line\n  second line\n---\n\n# s\n",
  );
  assert.equal(
    parseFrontmatterField(md, "description"),
    "first line second line",
  );

  writeFileSync(
    md,
    "---\nname: s\ndescription: |\n  alpha\n  beta\nother: x\n---\n\n# s\n",
  );
  assert.equal(parseFrontmatterField(md, "description"), "alpha beta");
});

test("parseFrontmatterName reads quoted and plain names", () => {
  const vault = makeTmp();
  const dir = makeSkill(vault, "cat", "my-skill", '"my-skill"');
  assert.equal(parseFrontmatterName(path.join(dir, "SKILL.md")), "my-skill");
});

test("scanVault finds skills at any depth, skips ignore dirs and archive/", () => {
  const vault = makeTmp();
  const cfg = makeConfig(vault, {});
  makeSkill(vault, "business", "alpha");
  makeSkill(vault, "deep/nested", "beta");
  makeSkill(vault, "node_modules", "hidden");
  makeSkill(vault, "archive", "old-one");
  const names = scanVault(vault, cfg).map((s) => s.name);
  assert.deepEqual(names, ["alpha", "beta"]);
});

test("validateVault flags invalid name, frontmatter mismatch, duplicates", () => {
  const vault = makeTmp();
  const cfg = makeConfig(vault, {});
  makeSkill(vault, "a", "Bad_Name");
  makeSkill(vault, "a", "mismatch", "other-name");
  makeSkill(vault, "b", "twin");
  makeSkill(vault, "c", "twin");
  const kinds = validateVault(scanVault(vault, cfg))
    .map((p) => p.kind)
    .sort();
  assert.deepEqual(kinds, ["duplicate", "invalid-name", "name-mismatch"]);
});

test("NAME_RE accepts kebab, rejects uppercase/underscore/leading-dash", () => {
  assert.ok(NAME_RE.test("skill-loom"));
  assert.ok(!NAME_RE.test("Skill"));
  assert.ok(!NAME_RE.test("a_b"));
  assert.ok(!NAME_RE.test("-x"));
});
