import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import {
  planLinks,
  applyPlan,
  statusMatrix,
  orphanLinks,
  setSkillLinks,
} from "../src/linker.js";
import { scanVault } from "../src/vault.js";
import { makeTmp, makeSkill, makeConfig } from "./helpers.js";

function setup() {
  const vault = makeTmp();
  const consumerDir = path.join(makeTmp(), "skills");
  const cfg = makeConfig(vault, { claude: consumerDir });
  return { vault, consumerDir, cfg };
}

test("planLinks: create → apply → ok; conflict on real dir; replace-stale on wrong symlink", () => {
  const { vault, consumerDir, cfg } = setup();
  const alphaDir = makeSkill(vault, "cat", "alpha");
  makeSkill(vault, "cat", "bravo");
  makeSkill(vault, "cat", "charlie");
  mkdirSync(path.join(consumerDir, "bravo"), { recursive: true }); // real dir → conflict
  mkdirSync(consumerDir, { recursive: true });
  symlinkSync("/nonexistent/place", path.join(consumerDir, "charlie")); // wrong symlink → replace-stale

  const skills = scanVault(vault, cfg);
  const plan = planLinks(skills, cfg);
  const byName = Object.fromEntries(plan.map((p) => [p.skill, p.action]));
  assert.deepEqual(byName, {
    alpha: "create",
    bravo: "conflict",
    charlie: "replace-stale",
  });

  applyPlan(plan);
  assert.equal(readlinkSync(path.join(consumerDir, "alpha")), alphaDir);
  assert.ok(lstatSync(path.join(consumerDir, "bravo")).isDirectory()); // conflict untouched
  const replan = planLinks(scanVault(vault, cfg), cfg);
  assert.deepEqual(Object.fromEntries(replan.map((p) => [p.skill, p.action])), {
    alpha: "ok",
    bravo: "conflict",
    charlie: "ok",
  });
});

test("statusMatrix: linked / missing / broken / foreign", () => {
  const { vault, consumerDir, cfg } = setup();
  const a = makeSkill(vault, "c", "linked-one");
  makeSkill(vault, "c", "missing-one");
  makeSkill(vault, "c", "broken-one");
  makeSkill(vault, "c", "foreign-one");
  mkdirSync(consumerDir, { recursive: true });
  symlinkSync(a, path.join(consumerDir, "linked-one"));
  symlinkSync("/nonexistent/x", path.join(consumerDir, "broken-one"));
  mkdirSync(path.join(consumerDir, "foreign-one"));

  const states = Object.fromEntries(
    statusMatrix(scanVault(vault, cfg), cfg).map((s) => [s.skill, s.state]),
  );
  assert.deepEqual(states, {
    "linked-one": "linked",
    "missing-one": "missing",
    "broken-one": "broken",
    "foreign-one": "foreign",
  });
});

test("orphanLinks finds consumer symlinks pointing into vault at removed skills", () => {
  const { vault, consumerDir, cfg } = setup();
  makeSkill(vault, "c", "alive");
  mkdirSync(consumerDir, { recursive: true });
  symlinkSync(path.join(vault, "c", "ghost"), path.join(consumerDir, "ghost"));
  symlinkSync("/somewhere/else", path.join(consumerDir, "unrelated"));
  const orphans = orphanLinks(vault, cfg, scanVault(vault, cfg));
  assert.deepEqual(orphans, [path.join(consumerDir, "ghost")]);
});

test("setSkillLinks links and unlinks one skill for one consumer", () => {
  const vault = makeTmp();
  const rt = makeTmp();
  const cfg = makeConfig(vault, { claude: rt });
  const dir = makeSkill(vault, "biz", "demo");
  const skills = [{ name: "demo", dir, frontmatterName: "demo" }];

  const on = setSkillLinks(skills, cfg, "claude", "demo", true, true);
  assert.equal(on.actions.length, 1);
  assert.ok(lstatSync(path.join(rt, "demo")).isSymbolicLink());

  const again = setSkillLinks(skills, cfg, "claude", "demo", true, true);
  assert.equal(again.actions.length, 0);

  const off = setSkillLinks(skills, cfg, "claude", "demo", false, true);
  assert.equal(off.actions.length, 1);
  assert.ok(!existsSync(path.join(rt, "demo")));
});

test("setSkillLinks never removes a real copy (foreign), reports skipped", () => {
  const vault = makeTmp();
  const rt = makeTmp();
  const cfg = makeConfig(vault, { claude: rt });
  const dir = makeSkill(vault, "biz", "demo");
  const skills = [{ name: "demo", dir, frontmatterName: "demo" }];
  mkdirSync(path.join(rt, "demo"), { recursive: true });
  const off = setSkillLinks(skills, cfg, "claude", "demo", false, true);
  assert.equal(off.actions.length, 0);
  assert.equal(off.skipped.length, 1);
  assert.ok(existsSync(path.join(rt, "demo")));
});

test("setSkillLinks throws on unknown consumer", () => {
  const cfg = makeConfig(makeTmp(), {});
  assert.throws(() => setSkillLinks([], cfg, "ghost", null, true, false));
});
