import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  scanVault,
  validateVault,
  skillWarnings,
  parseFrontmatterName,
  parseFrontmatterField,
  parseFirstH1,
  waiverReason,
  isActive,
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
  makeSkill(vault, ".archive", "old-one");
  const names = scanVault(vault, cfg).map((s) => s.name);
  assert.deepEqual(names, ["alpha", "beta"]);
});

test("scanVault reads the lifecycle status, defaulting to active", () => {
  const vault = makeTmp();
  const cfg = makeConfig(vault, {});
  const d1 = path.join(vault, "one");
  mkdirSync(d1, { recursive: true });
  writeFileSync(
    path.join(d1, "SKILL.md"),
    `---\nname: one\ndescription: x\nstatus: draft\n---\n\n# one\n`,
  );
  const d2 = path.join(vault, "two");
  mkdirSync(d2, { recursive: true });
  writeFileSync(
    path.join(d2, "SKILL.md"),
    `---\nname: two\ndescription: x\n---\n\n# two\n`,
  );
  const byName = Object.fromEntries(
    scanVault(vault, cfg).map((s) => [s.name, s]),
  );
  assert.equal(byName.one.status, "draft");
  assert.equal(byName.two.status, "active"); // default
  assert.equal(isActive(byName.two), true);
  assert.equal(isActive(byName.one), false);
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

test("parseFirstH1 returns the first heading after the frontmatter", () => {
  const vault = makeTmp();
  const md = path.join(makeSkill(vault, "c", "s"), "SKILL.md");
  writeFileSync(
    md,
    "---\nname: s\ndescription: d\n---\n\n# The Title\n\n# later\n",
  );
  assert.equal(parseFirstH1(md), "The Title");

  // no frontmatter → still finds the H1
  writeFileSync(md, "# Bare Title\n\nbody\n");
  assert.equal(parseFirstH1(md), "Bare Title");

  // no H1 at all
  writeFileSync(md, "---\nname: s\n---\n\njust prose\n");
  assert.equal(parseFirstH1(md), null);
});

test("skillWarnings flags H1≠name and machine-specific absolute paths", () => {
  const vault = makeTmp();
  const cfg = makeConfig(vault, {});
  // H1 differs from name
  const bad = makeSkill(vault, "a", "alpha");
  writeFileSync(
    path.join(bad, "SKILL.md"),
    "---\nname: alpha\ndescription: d\n---\n\n# Alpha Skill\n",
  );
  // absolute machine path in the body (H1 matches, so only the path warns)
  const port = makeSkill(vault, "a", "bravo");
  writeFileSync(
    path.join(port, "SKILL.md"),
    "---\nname: bravo\ndescription: d\n---\n\n# bravo\n\nRun /home/michele/tool.py\n",
  );
  // clean skill → no warnings
  makeSkill(vault, "a", "charlie");

  const w = skillWarnings(scanVault(vault, cfg));
  const byName = (n: string) =>
    w.filter((x) => x.name === n).map((x) => x.kind);
  assert.deepEqual(byName("alpha"), ["h1-mismatch"]);
  assert.deepEqual(byName("bravo"), ["absolute-path"]);
  assert.deepEqual(byName("charlie"), []);
});

test("skillWarnings runs config-driven lint checks when a lint block is set", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "alpha");
  writeFileSync(
    path.join(d, "SKILL.md"),
    "---\nname: alpha\ndescription: short\nlayer: bogus\n---\n\n# alpha\n\nbody\n",
  );
  const cfg = {
    ...base,
    lint: {
      descriptionMaxChars: 3, // "short" (5) exceeds → description-length
      requireTaxonomy: ["domain"], // domain absent → missing-taxonomy
      requireSections: ["Policy"], // no Policy heading → missing-section
      allowedLayers: ["tool", "engine"], // layer "bogus" → unknown-layer
    },
  };
  const kinds = skillWarnings(scanVault(vault, cfg), cfg)
    .map((w) => w.kind)
    .sort();
  assert.deepEqual(kinds, [
    "description-length",
    "missing-section",
    "missing-taxonomy",
    "unknown-layer",
  ]);
});

test("skillWarnings with no lint block only runs the built-in hygiene checks", () => {
  const vault = makeTmp();
  const cfg = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "alpha");
  // clean H1/path but a tiny description and no taxonomy: silent without lint
  writeFileSync(
    path.join(d, "SKILL.md"),
    "---\nname: alpha\ndescription: x\n---\n\n# alpha\n",
  );
  assert.deepEqual(skillWarnings(scanVault(vault, cfg), cfg), []);
});

test("NAME_RE accepts kebab, rejects uppercase/underscore/leading-dash", () => {
  assert.ok(NAME_RE.test("skill-loom"));
  assert.ok(!NAME_RE.test("Skill"));
  assert.ok(!NAME_RE.test("a_b"));
  assert.ok(!NAME_RE.test("-x"));
});

test("skillWarnings flags a description under descriptionMinChars", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  writeFileSync(
    path.join(d, "SKILL.md"),
    "---\nname: s\ndescription: too short\n---\n\n# s\n",
  );
  const cfg = { ...base, lint: { descriptionMinChars: 250 } };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(
    w.some(
      (x) => x.kind === "description-length" && x.detail.includes("< 250"),
    ),
  );
});

test("forbidBodyPatterns flags a forbidden regex in the body", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  writeFileSync(
    path.join(d, "SKILL.md"),
    "---\nname: s\ndescription: d\n---\n\n# s\n\nssh into 10.0.0.1 now\n",
  );
  const cfg = {
    ...base,
    lint: { forbidBodyPatterns: ["\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b"] },
  };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(
    w.some(
      (x) => x.kind === "forbidden-pattern" && x.detail.includes("10.0.0.1"),
    ),
  );
});

test("an invalid forbidBodyPatterns regex is surfaced, not thrown", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  makeSkill(vault, "a", "s");
  const cfg = { ...base, lint: { forbidBodyPatterns: ["(unclosed"] } };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(
    w.some(
      (x) => x.kind === "forbidden-pattern" && x.detail.includes("invalid"),
    ),
  );
});

test("bodyMaxLines fires without a waiver", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  const longBody = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  writeFileSync(
    path.join(d, "SKILL.md"),
    "---\nname: s\ndescription: d\n---\n\n# s\n" + longBody + "\n",
  );
  const cfg = { ...base, lint: { bodyMaxLines: 3 } };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(w.some((x) => x.kind === "body-length"));
});

test("bodyMaxLines is suppressed by a length-waiver", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  const longBody = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  const fm =
    "---\nname: s\ndescription: d\nmetadata:\n  lint:\n    length-waiver:\n      reason: runbook non separabile\n---\n\n# s\n" +
    longBody +
    "\n";
  writeFileSync(path.join(d, "SKILL.md"), fm);
  const cfg = { ...base, lint: { bodyMaxLines: 3 } };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(!w.some((x) => x.kind === "body-length"));
});

test("waiverReason reads the nested reason for a given key, else null", () => {
  const vault = makeTmp();
  const d = makeSkill(vault, "a", "s");
  const md = path.join(d, "SKILL.md");
  writeFileSync(md, "---\nname: s\ndescription: d\n---\n\n# s\n");
  assert.equal(waiverReason(md, "length-waiver"), null);
  writeFileSync(
    md,
    "---\nname: s\ndescription: d\nmetadata:\n  lint:\n    length-waiver:\n      reason: perché sì\n---\n\n# s\n",
  );
  assert.equal(waiverReason(md, "length-waiver"), "perché sì");
  // key-specific: a forbid-waiver is not read as a length-waiver
  assert.equal(waiverReason(md, "forbid-waiver"), null);
});

test("forbidBodyPatterns is suppressed by a forbid-waiver", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  writeFileSync(
    path.join(d, "SKILL.md"),
    "---\nname: s\ndescription: d\nmetadata:\n  lint:\n    forbid-waiver:\n      reason: topologia interna Argo\n---\n\n# s\n\nssh 10.0.0.1\n",
  );
  const cfg = {
    ...base,
    lint: { forbidBodyPatterns: ["\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b"] },
  };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(!w.some((x) => x.kind === "forbidden-pattern"));
});

test("skillWarnings treats an empty allowlist as no restriction, not flag-all", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  writeFileSync(
    path.join(d, "SKILL.md"),
    "---\nname: s\ndescription: d\ndomain: bottega19\nlayer: tool\n---\n\n# s\n",
  );
  const cfg = {
    ...base,
    lint: { allowedDomains: [], allowedLayers: [] },
  };
  const kinds = skillWarnings(scanVault(vault, cfg), cfg).map((w) => w.kind);
  assert.ok(!kinds.includes("unknown-domain"));
  assert.ok(!kinds.includes("unknown-layer"));
});
