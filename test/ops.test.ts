import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { addOp, archiveOp, migrateOp, restoreOp } from "../src/ops.js";
import { makeTmp, makeSkill, makeConfig } from "./helpers.js";

function vaultBare() {
  const vault = makeTmp();
  makeConfig(vault, {});
  return vault;
}

test("addOp dry-run touches nothing, apply scaffolds with description", () => {
  const vault = vaultBare();
  const dry = addOp(vault, "demo", "cat", "My custom description", false);
  assert.equal(dry.status, 0);
  assert.ok(dry.actions.length > 0);
  assert.ok(!existsSync(path.join(vault, "cat", "demo")));
  const wet = addOp(vault, "demo", "cat", "My custom description", true);
  assert.equal(wet.status, 0);
  const md = readFileSync(path.join(vault, "cat", "demo", "SKILL.md"), "utf8");
  assert.match(md, /^name: demo$/m);
  assert.match(md, /^description: My custom description$/m);
});

test("addOp rejects invalid and duplicate names with status 2", () => {
  const vault = vaultBare();
  assert.equal(addOp(vault, "Bad_Name", undefined, undefined, true).status, 2);
  addOp(vault, "twice", undefined, undefined, true);
  assert.equal(addOp(vault, "twice", undefined, undefined, true).status, 2);
});

test("addOp rejects a category that escapes the vault", () => {
  const vault = vaultBare();
  const out = addOp(vault, "evil", "../../outside", undefined, true);
  assert.equal(out.status, 2);
  assert.ok(
    !existsSync(path.join(path.dirname(path.dirname(vault)), "outside")),
  );
});

test("addOp still allows legitimate nested categories", () => {
  const vault = vaultBare();
  const out = addOp(vault, "nested", "a/b", undefined, true);
  assert.equal(out.status, 0);
  assert.ok(existsSync(path.join(vault, "a", "b", "nested", "SKILL.md")));
});

test("addOp collapses newlines in description", () => {
  const vault = vaultBare();
  addOp(vault, "multiline", undefined, "a\nb", true);
  const md = readFileSync(path.join(vault, "multiline", "SKILL.md"), "utf8");
  assert.match(md, /^description: a b$/m);
});

test("archiveOp and migrateOp report status 2 on missing skill", () => {
  const vault = vaultBare();
  assert.equal(archiveOp(vault, "ghost", undefined, true).status, 2);
  assert.equal(migrateOp(vault, "ghost", "new-name", true).status, 2);
});

test("archiveOp apply moves skill and records reason", () => {
  const vault = vaultBare();
  makeSkill(vault, "cat", "alpha");
  const out = archiveOp(vault, "alpha", "superseded", true);
  assert.equal(out.status, 0);
  assert.ok(existsSync(path.join(vault, "archive", "alpha", "SKILL.md")));
});

test("restoreOp moves an archived skill back to the vault root and re-links it", () => {
  const vault = makeTmp();
  const rt = makeTmp();
  makeConfig(vault, { claude: rt });
  makeSkill(vault, "biz", "demo");
  archiveOp(vault, "demo", "obsolete", true);
  assert.ok(existsSync(path.join(vault, "archive", "demo", "SKILL.md")));

  const dry = restoreOp(vault, "demo", false);
  assert.equal(dry.status, 0);
  assert.ok(dry.actions.length > 0);
  assert.ok(existsSync(path.join(vault, "archive", "demo")));

  const wet = restoreOp(vault, "demo", true);
  assert.equal(wet.status, 0);
  assert.ok(!existsSync(path.join(vault, "archive", "demo")));
  assert.ok(existsSync(path.join(vault, "demo", "SKILL.md")));
  assert.ok(lstatSync(path.join(rt, "demo")).isSymbolicLink());
  const cfg = JSON.parse(readFileSync(path.join(vault, "loom.json"), "utf8"));
  assert.equal(
    cfg.archived.find((a: { name: string }) => a.name === "demo"),
    undefined,
  );
});

test("restoreOp rejects unknown names with status 2", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  assert.equal(restoreOp(vault, "nope", true).status, 2);
});
